# Secrets and optional configuration (wave B)

Everything the Worker reads from `env` besides its bindings. Types live in
`apps/game/src/server/contracts.ts` (`Env`). Only `AUTH_SECRET` is required; every other entry is
optional, and leaving it out disables or stubs the feature it enables. Never commit real values:
`.dev.vars` is git-ignored, and `apps/game/.dev.vars.example` lists the keys with placeholders.

## Overview

| Name                    | Kind          | Required | Enables                                                                                                 |
| ----------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`           | secret        | yes      | HMAC key for session tokens and (with a derived key) the OAuth state cookie                             |
| `GOOGLE_CLIENT_ID`      | secret or var | no       | Real "Sign in with Google" (needs the secret too)                                                       |
| `GOOGLE_CLIENT_SECRET`  | secret        | no       | Same                                                                                                    |
| `DISCORD_CLIENT_ID`     | secret or var | no       | Real "Sign in with Discord" (needs the secret too)                                                      |
| `DISCORD_CLIENT_SECRET` | secret        | no       | Same                                                                                                    |
| `APPLE_CLIENT_ID`       | var           | no       | Reserved: Sign in with Apple is **stub-only in wave B** (see below)                                     |
| `APPLE_TEAM_ID`         | var           | no       | Reserved (Apple client-secret JWT)                                                                      |
| `APPLE_KEY_ID`          | var           | no       | Reserved (Apple client-secret JWT)                                                                      |
| `APPLE_PRIVATE_KEY`     | secret        | no       | Reserved (ES256 `.p8` key that signs the Apple client-secret JWT)                                       |
| `OAUTH_STUB`            | var           | no       | `"1"`: local stub OAuth provider (and `/api/dev/*`) on any host. `"0"`: never. Unset: only on dev hosts |
| `ADMIN_ACCOUNT_IDS`     | var           | no       | Comma-separated account ids allowed on `/api/admin/*` (chat moderation review)                          |
| `MODERATION`            | var           | no       | Chat moderation: `"llama-guard"` (default when `AI` is bound), `"stub"`, `"off"`                        |
| `AI`                    | binding       | no       | Workers AI, used by chat moderation (Llama Guard). Not bound by default                                 |

"secret" = set with `cf workers secrets …` (encrypted, write-only). "var" = a plain text binding
(`bindings.text(...)` in `cloudflare.config.ts`) or a secret; client ids are not sensitive, but
keeping them as secrets is fine and keeps them out of the repo.

## `AUTH_SECRET` (required)

- Signs every session token (`<base64url payload>.<HMAC-SHA256>`, `apps/game/src/server/auth.ts`).
  The OAuth state cookie `gz_oauth` is signed with a key derived from it (domain-separated, so a
  token can never pass as a cookie or the other way round).
- Use at least 32 random bytes, e.g. `openssl rand -base64 48`.
- **Rotating it logs everyone out**: all guest tokens become invalid too, and a guest whose token
  is gone cannot get back to its account (guests have no other login). Rotate only for a leak.
- Local dev: `apps/game/.dev.vars` (`AUTH_SECRET=dev-only-secret-change-me` is fine locally).

## OAuth providers

The callback URL to register with every provider is

```
https://<host>/api/auth/oauth/<provider>/callback
```

for example `https://gamez.example.com/api/auth/oauth/google/callback`. Register one per host you
serve (production, previews you want to log in on). `http://localhost:5173/...` works for local
testing with real credentials (Google allows `http://localhost`; Discord allows any exact URL).

Flow (`apps/game/src/server/routes/auth.ts`, `auth/oauth/*`): authorization code with PKCE S256,
a signed `gz_oauth` cookie (HttpOnly, SameSite=Lax, Secure on https, 10 minutes, path
`/api/auth/oauth`) carrying the state, the verifier and the optional link target. Success redirects
to `/#auth=<token>`, failure to `/#auth_error=<code>`.

A provider is "real" only when **both** its client id and secret are set. Otherwise it is served by
the stub on dev hosts and reported `enabled: false` elsewhere (`GET /api/auth/providers`).

### Google

1. Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID →
   type "Web application".
2. Authorized redirect URIs: the callback URL above (provider `google`).
3. OAuth consent screen: scopes `openid`, `email`, `profile` (non-sensitive; no verification needed
   for these).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The Worker calls `https://oauth2.googleapis.com/token` and
`https://openidconnect.googleapis.com/v1/userinfo`; the email is kept only when
`email_verified` is true. The account key is Google's `sub`.

### Discord

1. Discord developer portal → Applications → New Application → OAuth2.
2. Redirects: the callback URL above (provider `discord`).
3. Scopes requested: `identify email`.
4. Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

The Worker calls `https://discord.com/api/oauth2/token` and `https://discord.com/api/users/@me`;
the email is kept only when `verified` is true. The account key is the Discord user id.

### Apple (stub only in wave B)

Real Sign in with Apple is **not implemented** in wave B. It needs a client secret that is an
ES256-signed JWT (`iss` = `APPLE_TEAM_ID`, `sub` = `APPLE_CLIENT_ID` (the Services ID), `kid` =
`APPLE_KEY_ID`, signed with `APPLE_PRIVATE_KEY`, the `.p8` key from the Apple developer portal),
`response_mode=form_post` (the callback must accept POST), and the user's name arrives only on the
first authorization. Until that lands, Apple is a stub on dev hosts and `provider_disabled`
elsewhere, whatever the `APPLE_*` values are. Apple requires Sign in with Apple in the iOS app when
other social logins are offered (phase 6).

### The local stub provider

Used when a provider is unconfigured **and** `isDevHost` holds (`apps/game/src/server/http.ts`):
`OAUTH_STUB === "1"`, or `OAUTH_STUB` unset and the host is `localhost`, `127.0.0.1`, `[::1]` or a
tailnet `*.ts.net` name. `OAUTH_STUB=0` turns it off everywhere. Production hosts never match.

`/start` redirects to `/api/auth/oauth/<provider>/stub`, a small form (subject, email, name). Its
POST redirects to the callback with `code=stub:<base64url JSON>`, which carries the PKCE challenge;
the callback checks it against the cookie's verifier and makes no network calls. Stub logins are
stored as `<provider>:stub-<subject>`, so they never collide with real provider ids.

**Never set `OAUTH_STUB=1` on a public deployment**: anyone could then sign in as any stub
subject (and `/api/dev/*` would open).

## Admin and moderation

- `ADMIN_ACCOUNT_IDS`: comma-separated account ids (see `GET /api/me` → `accountId`). Not
  sensitive, but keep it out of the repo for production. Admin calls authenticate with the
  account's normal session token.
- `MODERATION`: Llama Guard (`@cf/meta/llama-guard-3-8b` via `env.AI`) runs when `AI` is bound and
  `MODERATION` is not `"stub"`/`"off"`; otherwise the local stub moderator (flags texts containing
  `[unsafe-test]`, used by tests and e2e) runs. `"off"` disables async moderation (the word filter
  and rate limits stay).

### Workers AI binding `AI` (optional)

Not bound by default (it costs Workers AI neurons and needs the account to have Workers AI). To
enable it later, add to `env` in `apps/game/cloudflare.config.ts`:

```ts
AI: bindings.ai(),
```

(`bindings.ai(options?)` exists in `@cloudflare/config` 0.28; local dev of AI bindings calls the
remote service and may need `cf auth`, **unverified**). The contract type is `WorkersAiLike`
(`run(model, input)`), so nothing else changes.

## Setting secrets with `cf`

Checked against `cf --help` on `cf` 1.0.0-beta.20/23. **Nothing here has been run**; every command
below is mutating except `get`/`list`.

```sh
# one secret (the value lands in shell history; prefer the bulk/file forms)
cf workers secrets update GOOGLE_CLIENT_SECRET --worker gamez --text "<value>"

# several at once, in one new Worker version (JSON Merge Patch)
cf workers secrets bulk --worker gamez --secrets @secrets.json --dry-run

# read-only checks
cf workers secrets list --worker gamez
cf workers secrets get GOOGLE_CLIENT_SECRET --worker gamez   # value omitted
```

- `--secrets` takes "a map of secret names to secret values … a secret object" (from `--help`);
  the exact shape of that secret object (e.g. `{"type": "secret_text", "text": "…"}`) is
  **unverified**. Run with `--dry-run` first.
- `cf deploy --secrets-file <path>` uploads secrets together with a deploy (verified flag, see
  `docs/deploy.md` §4).
- Whether Workers Builds keeps secrets set this way across later builds is **unverified** (same
  open question as `AUTH_SECRET` in `docs/deploy.md`).

### Local development

Put values in `apps/game/.dev.vars` (git-ignored; copy the keys from `.dev.vars.example`).

`cloudflare.config.ts` declares `AUTH_SECRET: bindings.secret()`. Per the `@cloudflare/config`
docs, declaring secrets "replaces .dev.vars inference": optional keys that are **not** declared
might not reach `env` in local dev (**unverified**). If a `.dev.vars` entry such as
`GOOGLE_CLIENT_ID` seems ignored, declare it as `bindings.secret()` in `cloudflare.config.ts`
(a declared secret that is missing only produces a local warning).

## Never

- Never commit real values, and never put them in `cloudflare.config.ts` as `text(...)` unless
  they are public (client ids).
- Never invent keys in docs or tests: tests use obviously fake values (`gid`, `gs`).
- Never enable the stub provider (`OAUTH_STUB=1`) on a public host.
