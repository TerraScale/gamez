#!/usr/bin/env python3
"""Log in to Nextcloud or run its MCP server for this repository."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import tomllib
import webbrowser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request


HOST = "https://next.mariogk.com"
PACKAGE = "nextcloud-mcp-server==0.202.2"
ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS = ROOT / ".nextcloud-mcp.local.json"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def same_server(url):
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != urlsplit(HOST).netloc
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Nextcloud returned an unexpected server URL")
    return url


def post(url, fields=None):
    request = Request(
        same_server(url),
        data=urlencode(fields or {}).encode(),
        headers={
            "User-Agent": "gamez MCP (Codex and Claude)",
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with build_opener(NoRedirects()).open(request, timeout=20) as response:
        return json.load(response)


def login():
    flow = post(f"{HOST}/index.php/login/v2")
    login_url = same_server(flow["login"])
    endpoint = same_server(flow["poll"]["endpoint"])
    print(f"Open this URL and grant access to gamez MCP:\n{login_url}", flush=True)
    try:
        webbrowser.open(login_url)
    except webbrowser.Error:
        pass  # The printed link also works on machines without a desktop browser.
    print("Waiting for browser authorization (up to 20 minutes)...", flush=True)
    deadline = time.monotonic() + 20 * 60
    while time.monotonic() < deadline:
        try:
            result = post(endpoint, {"token": flow["poll"]["token"]})
        except HTTPError as error:
            if error.code != 404:
                raise
            time.sleep(2)
            continue
        credentials = {
            "NEXTCLOUD_HOST": same_server(result["server"]).rstrip("/"),
            "NEXTCLOUD_USERNAME": result["loginName"],
            "NEXTCLOUD_PASSWORD": result["appPassword"],
        }
        if not all(isinstance(value, str) and value for value in credentials.values()):
            raise ValueError("Nextcloud returned incomplete credentials")
        descriptor, temporary = tempfile.mkstemp(prefix=".nextcloud-mcp-", dir=ROOT)
        try:
            with os.fdopen(descriptor, "w") as output:
                json.dump(credentials, output, indent=2)
                output.write("\n")
            os.replace(temporary, CREDENTIALS)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f"Saved app credentials to {CREDENTIALS.name} (owner access only).")
        print("After verification, restart Codex or Claude and check /mcp.", flush=True)
        check()
        return
    raise ValueError("Login expired. Run the login command again.")


def run():
    if not CREDENTIALS.exists():
        raise ValueError("Run python3 tools/mcp/nextcloud.py login from the repo first.")
    with CREDENTIALS.open() as source:
        credentials = json.load(source)
    environment = os.environ.copy()
    for key in ("NEXTCLOUD_HOST", "NEXTCLOUD_USERNAME", "NEXTCLOUD_PASSWORD"):
        value = credentials.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"Missing {key}; run the login command again.")
        environment[key] = value
    same_server(environment["NEXTCLOUD_HOST"])
    if not shutil.which("uvx"):
        raise ValueError("Install uv (https://docs.astral.sh/uv/) to provide uvx.")
    os.execvpe("uvx", ["uvx", PACKAGE, "run", "--transport", "stdio"], environment)


def check():
    if not CREDENTIALS.exists():
        raise ValueError("Run python3 tools/mcp/nextcloud.py login from the repo first.")
    try:
        import mcp  # noqa: F401
    except ImportError:
        if not shutil.which("uvx"):
            raise ValueError("Install uv (https://docs.astral.sh/uv/) to provide uvx.")
        os.execvp("uvx", ["uvx", "--from", PACKAGE, "python", str(Path(__file__).resolve()), "check"])
    asyncio.run(asyncio.wait_for(verify_connection(), timeout=120))


async def verify_connection():
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    with (ROOT / ".codex/config.toml").open("rb") as source:
        codex = tomllib.load(source)["mcp_servers"]["nextcloud"]
    with (ROOT / ".mcp.json").open() as source:
        claude = json.load(source)["mcpServers"]["nextcloud"]
    if (codex["command"], codex["args"]) != (claude["command"], claude["args"]):
        raise ValueError("Codex and Claude have different Nextcloud launch commands.")
    server = StdioServerParameters(command=codex["command"], args=codex["args"], cwd=str(ROOT))
    print("Checking the Nextcloud MCP connection...", flush=True)
    with tempfile.TemporaryFile(mode="w+") as server_log:
        async with stdio_client(server, errlog=server_log) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
                if not any(tool.name == "nc_webdav_list_directory" for tool in tools.tools):
                    raise ValueError("Nextcloud MCP did not expose its directory listing tool.")
                result = await session.call_tool("nc_webdav_list_directory", {"path": ""})
                if result.is_error:
                    raise ValueError("Nextcloud file access failed. Check your app password and Files app.")
                print("Codex and Claude launch configuration: OK")
                print(f"MCP handshake: OK ({initialized.server_info.name})")
                print(f"Tool discovery: OK ({len(tools.tools)} tools)")
                print("Authenticated root directory listing: OK (read-only)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("login", "run", "check"))
    args = parser.parse_args()
    try:
        {"login": login, "run": run, "check": check}[args.command]()
    except HTTPError as error:
        print(f"Nextcloud returned HTTP {error.code}.", file=sys.stderr)
        return 1
    except ExceptionGroup as error:
        while isinstance(error, BaseExceptionGroup):
            error = error.exceptions[0]
        print(f"Nextcloud MCP: {error}", file=sys.stderr)
        return 1
    except (URLError, OSError, ValueError, KeyError) as error:
        print(f"Nextcloud MCP: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
