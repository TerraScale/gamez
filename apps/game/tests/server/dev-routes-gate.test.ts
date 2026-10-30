/**
 * Every /api/dev/* route is invisible (404) unless DEV_ROUTES_ENABLED === "1",
 * whatever the host (localhost, tailnet *.ts.net) and OAUTH_STUB say. The
 * paths come from the server sources, so a new dev route is covered as soon as
 * it exists. The refusal must happen before any binding is touched.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { ROUTES } from "../../src/server/routes/index.ts";

const SECRET = "test-secret";
const SERVER_DIR = join(import.meta.dirname, "../../src/server");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** Every "/api/dev/..." string literal in the server sources. */
function devPaths(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SERVER_DIR)) {
    for (const m of readFileSync(file, "utf8").matchAll(/"(\/api\/dev\/[A-Za-z0-9/_-]*)"/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

/** A binding that fails the test if a refused dev route reaches it. */
function untouchable(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, key) {
        throw new Error(`dev route touched ${name}.${String(key)} without DEV_ROUTES_ENABLED`);
      },
    },
  );
}

const BINDINGS = [
  "RELAY",
  "CHUNK",
  "CHARACTER",
  "INSTANCE",
  "ACCOUNT",
  "IDENTITY",
  "CHAT",
  "GUILD",
  "ESCROW",
  "MARKET",
  "PLOTS",
  "SHOP",
  "ARENA",
  "CONFIG",
  "METRICS",
  "DB",
  "SYNC_QUEUE",
];

function envWith(vars: Record<string, string | undefined>): Env {
  const env: Record<string, unknown> = { AUTH_SECRET: SECRET, ...vars };
  for (const b of BINDINGS) env[b] = untouchable(b);
  return env as unknown as Env;
}

async function dispatch(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  for (const route of ROUTES) {
    const res = await route({ request, env, url, ctx: {} as ExecutionContext });
    if (res) return res;
  }
  return null;
}

describe("dev routes gate (DEV_ROUTES_ENABLED)", () => {
  const paths = devPaths();

  it("finds the dev routes in the sources", () => {
    expect(paths).toContain("/api/dev/admin/self");
    expect(paths).toContain("/api/dev/economy/grant");
    expect(paths.length).toBeGreaterThanOrEqual(9);
  });

  it("answers 404 for every /api/dev/* path, method and dev-looking host without the flag", async () => {
    const token = await signToken(SECRET, { accountId: "acc-x", name: "x", issuedAt: Date.now() });
    const hosts = ["http://localhost:5173", "https://box.tail1234.ts.net", "http://127.0.0.1:5403"];
    const envs = [
      envWith({}),
      envWith({ DEV_ROUTES_ENABLED: "0" }),
      envWith({ DEV_ROUTES_ENABLED: "true", OAUTH_STUB: "1" }),
      envWith({ OAUTH_STUB: "1" }),
    ];
    for (const env of envs) {
      for (const host of hosts) {
        for (const path of paths) {
          for (const method of ["GET", "POST"]) {
            const res = await dispatch(
              env,
              new Request(`${host}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: method === "POST" ? JSON.stringify({ xp: 1, sku: "x", world: "w" }) : null,
              }),
            );
            expect(res?.status, `${method} ${host}${path}`).toBe(404);
          }
        }
      }
    }
  });
});
