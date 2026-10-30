/**
 * ADR 0012 e2e: per-IP limits on guest minting and chat connects (the ADR 0007
 * R9b follow-up), and the dev-admin grant behind DEV_ROUTES_ENABLED, against
 * the real dev server and its local Rate Limiting bindings.
 *
 * The dev server exempts loopback callers (the rest of the e2e mints many
 * guests from 127.0.0.1), so this part sends `cf-connecting-ip` with a fresh
 * TEST-NET-3 address per run: in production Cloudflare sets that header
 * itself, so a client can never pick its own bucket there.
 */
import { api } from "./accounts.ts";
import { loginGuest } from "./client.ts";
import type { E2eContext } from "./features.ts";
import { check } from "./report.ts";

/** Limits from apps/game/cloudflare.config.ts IP_LIMITS. */
const GUEST_LIMIT = 20;
const CHAT_CONNECT_LIMIT = 60;

/** A TEST-NET-3 address (203.0.113.0/24) unlikely to repeat between runs on one server. */
function testIp(): string {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

async function mintFrom(url: string, ip: string): Promise<Response> {
  return fetch(`${url}/api/guest`, { method: "POST", headers: { "cf-connecting-ip": ip } });
}

/**
 * Opens /ws/chat from `ip`. Resolves 1000 once the channel's welcome frame
 * arrives (accepted), else the server's close code. A refusal is an accepted
 * upgrade closed at once, so the socket must not close itself on "open".
 */
function chatConnect(url: string, token: string, ip: string): Promise<number> {
  const wsUrl = `${url.replace(/^http/, "ws")}/ws/chat?token=${encodeURIComponent(token)}&channel=global`;
  // Node's WebSocket (undici) takes extra request headers in its init object.
  const Ws = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new Ws(wsUrl, { headers: { "cf-connecting-ip": ip } });
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      ws.close();
      finish(-1);
    }, 10_000);
    ws.addEventListener("message", (ev: MessageEvent<string>) => {
      const t = (JSON.parse(String(ev.data)) as { t?: string }).t;
      if (t !== "welcome") return;
      ws.close(1000, "e2e");
      finish(1000);
    });
    ws.addEventListener("close", (ev) => finish(ev.code));
  });
}

/** 20 guests per IP per minute, then 429 with Retry-After; other IPs are unaffected. */
export async function guestMintLimit(ctx: E2eContext): Promise<void> {
  const ip = testIp();
  const statuses: number[] = [];
  for (let i = 0; i < GUEST_LIMIT; i++) statuses.push((await mintFrom(ctx.url, ip)).status);
  check(
    statuses.every((s) => s === 200),
    `ip-limits: ${GUEST_LIMIT} guests from one IP are minted (got ${statuses.join(",")})`,
  );
  const refused = await mintFrom(ctx.url, ip);
  const body = (await refused.json().catch(() => null)) as { error?: { code?: string } } | null;
  check(
    refused.status === 429 && body?.error?.code === "rate_limited",
    `ip-limits: guest #${GUEST_LIMIT + 1} from the same IP answers 429 rate_limited (got ${refused.status} ${body?.error?.code})`,
  );
  check(
    refused.headers.get("retry-after") === "60",
    `ip-limits: the 429 carries Retry-After: 60 (got ${refused.headers.get("retry-after")})`,
  );
  let other = testIp();
  while (other === ip) other = testIp();
  const fresh = await mintFrom(ctx.url, other);
  check(fresh.status === 200, `ip-limits: another IP still mints (got ${fresh.status})`);
  const local = await fetch(`${ctx.url}/api/guest`, { method: "POST" });
  check(
    local.status === 200,
    `ip-limits: loopback dev callers are not limited (got ${local.status})`,
  );
}

/** 60 chat connects per IP per minute, then the upgrade closes with 4429. */
export async function chatConnectLimit(ctx: E2eContext): Promise<void> {
  const ip = testIp();
  const codes: number[] = [];
  // Batches of 10 keep the run short without opening 60 sockets at once.
  for (let i = 0; i < CHAT_CONNECT_LIMIT; i += 10) {
    codes.push(
      ...(await Promise.all(
        Array.from({ length: 10 }, () => chatConnect(ctx.url, ctx.guestA.token, ip)),
      )),
    );
  }
  const opened = codes.filter((c) => c === 1000).length;
  check(
    opened === CHAT_CONNECT_LIMIT,
    `ip-limits: ${CHAT_CONNECT_LIMIT} chat connects from one IP open (opened ${opened}, codes ${[...new Set(codes)].join(",")})`,
  );
  const refused = await chatConnect(ctx.url, ctx.guestA.token, ip);
  check(
    refused === 4429,
    `ip-limits: chat connect #${CHAT_CONNECT_LIMIT + 1} closes with 4429 (got ${refused})`,
  );
  const otherIp = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
  const other = await chatConnect(ctx.url, ctx.guestA.token, otherIp);
  check(other === 1000, `ip-limits: another IP still connects to chat (got ${other})`);
}

/** The local dev server sets DEV_ROUTES_ENABLED=1 (.dev.vars), so the dev-admin grant exists. */
export async function devAdminGrant(ctx: E2eContext): Promise<void> {
  // A fresh guest: the shared guests must stay plain players for the other features.
  const guest = await loginGuest(ctx.url);
  const res = await api<{ admin?: string }>(ctx.url, "/api/dev/admin/self", {
    token: guest.token,
    method: "POST",
  });
  check(
    res.status === 200 && res.body.admin === "dev",
    `dev routes: DEV_ROUTES_ENABLED=1 dev server grants POST /api/dev/admin/self (got ${res.status})`,
  );
}
