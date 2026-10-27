import { describe, expect, it } from "vite-plus/test";
import { newGuest, signToken } from "../../src/server/auth.ts";
import { INSTANCE_HEADERS } from "../../src/server/contracts.ts";
import { connectInstance } from "../../src/server/instance/route.ts";
import { instanceName, loadedMode } from "../../src/server/instance/modes.ts";
import { CATALOG, TEST_MODES } from "./fixtures.ts";

const SECRET = "test-secret";

function fakeEnv() {
  const calls: { name: string; opts: unknown; request: Request }[] = [];
  const env = {
    AUTH_SECRET: SECRET,
    INSTANCE: {
      getByName(name: string, opts?: unknown) {
        return {
          fetch(request: Request) {
            calls.push({ name, opts, request });
            return Promise.resolve(new Response("forwarded"));
          },
        };
      },
    },
  };
  return { env: env as unknown as Parameters<typeof connectInstance>[1], calls };
}

function upgrade(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { Upgrade: "websocket", ...headers } });
}

describe("connectInstance", () => {
  it("requires a websocket upgrade", async () => {
    const { env } = fakeEnv();
    const url = new URL("https://g.test/ws/instance?mode=tcount");
    const res = await connectInstance(new Request(url), env, url, TEST_MODES);
    expect(res.status).toBe(426);
  });

  it("404s for modes that are not in the catalog", async () => {
    const { env, calls } = fakeEnv();
    const url = new URL("https://g.test/ws/instance?token=x&mode=nope");
    const res = await connectInstance(upgrade(url.href), env, url, TEST_MODES);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("forwards to the player's instance with identity headers it sets itself", async () => {
    const { env, calls } = fakeEnv();
    const identity = newGuest();
    const token = await signToken(SECRET, identity);
    const url = new URL(
      `https://g.test/ws/instance?token=${encodeURIComponent(token)}&mode=tcount`,
    );
    const res = await connectInstance(
      upgrade(url.href, { [INSTANCE_HEADERS.accountId]: "spoofed" }),
      env,
      url,
      TEST_MODES,
    );
    expect(await res.text()).toBe("forwarded");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.name).toBe(`tcount:${identity.accountId}`);
    expect(call.opts).toBeUndefined(); // no request.cf outside Workers
    expect(call.request.headers.get(INSTANCE_HEADERS.accountId)).toBe(identity.accountId);
    expect(call.request.headers.get(INSTANCE_HEADERS.name)).toBe(identity.name);
    expect(call.request.headers.get(INSTANCE_HEADERS.mode)).toBe("tcount");
  });
});

describe("instance modes", () => {
  it("names instances <mode>:<accountId>", () => {
    expect(instanceName("steps", "a1")).toBe("steps:a1");
  });

  it("loads each mode once per catalog and returns null for unknown modes", () => {
    const a = loadedMode("tcount", TEST_MODES, CATALOG);
    expect(a?.mode.id).toBe("tcount");
    expect(loadedMode("tcount", TEST_MODES, CATALOG)).toBe(a);
    expect(loadedMode("nope", TEST_MODES, CATALOG)).toBeNull();
  });
});
