# Nextcloud MCP for Codex and Claude Code

This repo connects both clients to <https://next.mariogk.com> using the
[Nextcloud MCP server](https://github.com/cbcoutinho/nextcloud-mcp-server).
Each client launches its own local stdio process with the same app credentials.
No server deployment or Nextcloud plugin is required.

Prerequisites: Python 3.11+ (`python3`), `git`, `bash`, and [`uvx`](https://docs.astral.sh/uv/)
on your PATH. The MCP package is pinned to `nextcloud-mcp-server==0.202.2`.

From this repository, run:

```sh
python3 tools/mcp/nextcloud.py login
```

The helper opens your browser and also prints the login link. Sign in and grant access to
**gamez MCP (Codex and Claude)**. The helper uses Nextcloud Login Flow v2 to
obtain a dedicated app password. Your account password stays in the browser.
The helper saves the app credentials in `.nextcloud-mcp.local.json`, with
owner-only permissions. Git ignores this file and temporary credential files.
Do not copy credentials into either client's tracked config.

After authorization, the helper automatically checks the MCP handshake, tool
discovery, and a read-only listing of your Nextcloud root directory. To repeat
this check at any time:

```sh
python3 tools/mcp/nextcloud.py check
```

Restart your client after login:

- **Codex:** `.codex/config.toml` registers `nextcloud` for this trusted repo.
  Run `codex mcp get nextcloud` to inspect registration and `/mcp` inside Codex
  to check connection status.
- **Claude Code:** `.mcp.json` registers `nextcloud` at project scope. Accept
  Claude's project MCP approval if prompted, then check `/mcp`.

On this machine, the ignored `.claude/settings.local.json` enables the
`nextcloud` project server. Other clones may prompt for approval. This setting
enables the connection and does not automatically approve tool calls.

Try asking the client to list your Nextcloud files. App-specific tools (Notes,
Calendar, Deck, and others) depend on which apps are enabled in Nextcloud.
The server includes tools that can change data; normal client tool permissions
still apply. No tool permissions are automatically granted by this setup.

To reconnect, run the login helper again. To revoke access, remove
**gamez MCP (Codex and Claude)** under Nextcloud **Personal settings → Security →
Devices & sessions**, then delete `.nextcloud-mcp.local.json` locally. Logging
in again does not revoke a previous app password automatically.

The first launch downloads the pinned package through `uvx`; later launches use
its cache. If startup times out, run `uvx nextcloud-mcp-server==0.202.2 --help`
once in a terminal, then reconnect. If authentication expires, rerun login.

References:

- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Nextcloud Login Flow v2](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2)
