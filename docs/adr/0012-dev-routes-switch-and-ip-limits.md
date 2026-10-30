# ADR 0012: Explicit dev-routes switch and per-IP limits

- Status: accepted
- Date: 2026-10-30

Two security follow-ups: the dev-admin shortcut found in review, and the per-IP limits that
ADR 0007 R9 and R9b left as follow-ups.

## 1. Dev-only stubs need an explicit switch

**Problem.** `http.ts isDevHost` decided on the host name alone: `localhost`, `127.0.0.1`,
`[::1]` and every tailnet `*.ts.net` name counted as dev hosts (and `OAUTH_STUB=1` made any host
one). So a deployment reached through a tailnet name (Tailscale Serve or Funnel, a staging box)
served `/api/dev/*`. Anyone who could reach it could `POST /api/dev/admin/self` and become an
admin, mint coins and gems (`/api/dev/economy/grant`), sign in as any stub OAuth subject, and buy
gems from the payments stub.

**Decision.**

- Every dev-only stub (`/api/dev/*`, the stub OAuth provider, the payments stub and dev-admin
  rights) now requires `env.DEV_ROUTES_ENABLED === "1"`. Without it `isDevHost` is false on every
  host and every `/api/dev/*` path answers 404 before it touches a binding. With it, the earlier
  host rule still applies (`OAUTH_STUB=0` off, `OAUTH_STUB=1` any host, else localhost, loopback or
  `*.ts.net`), so local and tailnet dev keep working.
- `cloudflare.config.ts` declares `DEV_ROUTES_ENABLED` as a secret **only when the config is
  evaluated in a non-production, non-preview mode** (`vp dev`). Undeclared `.dev.vars` keys do not
  reach `env` in local dev (`docs/secrets.md`), and a production build (`vite build`, mode
  `production`) or `cf deploy` never declares or reads it, and a missing secret there cannot fail a
  deploy. `apps/game/.dev.vars.example` (copied by CI and new worktrees) sets
  `DEV_ROUTES_ENABLED=1`.
- The payments stub follows the switch even when `PAYMENTS_STUB=1`.
- A dev-admin grant made earlier stops counting as soon as the switch is off.
- Every grant logs one JSON line through `console.warn`:
  `{"event":"dev_admin_grant","accountId","kind","host","at"}` (Workers Logs keeps console
  output).

**Verified (2026-10-30).** The production build
(`.cloudflare/output/v0/workers/default/worker.config.json`) has no `DEV_ROUTES_ENABLED` binding
and has both rate-limit bindings. A `vp dev --mode qaprobe` server whose `.dev.vars.qaprobe` lacked
the key answered 404 for `/api/dev/{admin/self,economy/grant,grant,pass/xp}` on localhost. On that
server, Google `/start` redirected with `provider_disabled`, `/api/store` listed the payments stub
as disabled, and loopback guest mints were limited at 20/min.

**Consequences.** Production can only run the stubs if someone uploads a `DEV_ROUTES_ENABLED`
secret by hand. Tests: `tests/server/dev-routes-gate.test.ts` finds every `"/api/dev/..."` literal
in the server sources and checks that each one answers 404 for GET and POST on localhost,
tailnet and loopback hosts, with the switch unset, `"0"` or `"true"`, and with `OAUTH_STUB=1`. The
test fails loudly if a refused route touches a binding. `tests/admin/route.test.ts` covers the
grant log, `tests/auth/oauth.test.ts` the stub provider and `tests/payments/stub.test.ts` the
payments stub. The e2e checks the grant still works on the dev server.

## 2. Per-IP limits on guest minting and chat connects

**Problem.** `POST /api/guest` and `/ws/chat` had no per-IP limit. One client could mint unlimited
guests and hold unlimited chat sockets, which bounds the per-socket state that R9 and R9b cap only
per socket or per account.

**Decision.**

- Use **Cloudflare Rate Limiting bindings** (`bindings.rateLimit` in `cf/config`): `GUEST_LIMITER`
  allows 20 guests per IP per 60 s (namespace 47001), and `CHAT_CONNECT_LIMITER` allows 60 chat
  upgrades per IP per 60 s (namespace 47002). Each counts across isolates in a location, with no
  DO round-trip or storage of our own. A DO-backed limiter would have been exact but would add a
  DO hop to every guest mint and chat connect.
- The key is never the raw IP. It is `HMAC-SHA256(K, scope + ":" + ip)` truncated to 128 bits,
  where `K = HMAC-SHA256(AUTH_SECRET, "gamez/ip-limit/v1")`. The IP comes from
  `cf-connecting-ip`, which Cloudflare sets and overwrites in production.
- `POST /api/guest` over the limit answers `429 {error: {code: "rate_limited", retryAfterMs}}`
  with `Retry-After: 60`. A chat upgrade over the limit closes with **4429**, checked before the
  token or any DO, and the client then reconnects at its slowest backoff.
- The check fails open. A missing binding, as in unit tests, or a binding error lets the request
  through and logs. A limiter outage must not block sign-up, and the per-socket and per-account
  limits still apply.
- With `DEV_ROUTES_ENABLED=1`, callers without `cf-connecting-ip` or from loopback are not
  counted, so the local e2e and the bots (hundreds of guests from 127.0.0.1) keep working.
  Production has no exemption, and a request without the header counts under the key `unknown`.

**Limits chosen.** 20 guests a minute leaves room for a shared NAT (a school or an office) where
many people open the game at once. A browser keeps its guest token, so one person mints one
guest. 60 chat connects a minute covers two channels per tab, several tabs and reconnect storms
after a network drop, because the client backs off to 10 s.

**Consequences.** Mobile carrier CGNAT can put many players behind one IP. If that shows up, raise
`IP_LIMITS.guest` in `cloudflare.config.ts`. The bindings count per Cloudflare location, so the
limit is approximate and not global, which is enough to stop a flood from one client. Tests:
`tests/server/ip-limit.test.ts` covers salted keys, scopes, the dev exemption, fail-open, the guest
429 and the 4429 close before any DO. The `security` e2e feature mints 20 guests from one test IP
and expects a 429 on the 21st, opens 60 chat sockets and expects 4429 on the 61st, and checks that
other IPs and loopback stay unaffected.
