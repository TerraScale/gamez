# Secrets and optional configuration (wave B)

Everything the Worker reads from `env` besides its bindings. Types live in
`apps/game/src/server/contracts.ts` (`Env`). Only `AUTH_SECRET` is required; every other entry is
optional, and leaving it out disables or stubs the feature it enables. Never commit real values:
`.dev.vars` is git-ignored, and `apps/game/.dev.vars.example` lists the keys with placeholders.

## Overview

| Name                    | Kind          | Required | Enables                                                                                                           |
| ----------------------- | ------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`           | secret        | yes      | HMAC key for session tokens and (with a derived key) the OAuth state cookie                                       |
| `GOOGLE_CLIENT_ID`      | secret or var | no       | Real "Sign in with Google" (needs the secret too)                                                                 |
| `GOOGLE_CLIENT_SECRET`  | secret        | no       | Same                                                                                                              |
| `DISCORD_CLIENT_ID`     | secret or var | no       | Real "Sign in with Discord" (needs the secret too)                                                                |
| `DISCORD_CLIENT_SECRET` | secret        | no       | Same                                                                                                              |
| `APPLE_CLIENT_ID`       | var           | no       | Reserved: Sign in with Apple is **stub-only in wave B** (see below)                                               |
| `APPLE_TEAM_ID`         | var           | no       | Reserved (Apple client-secret JWT)                                                                                |
| `APPLE_KEY_ID`          | var           | no       | Reserved (Apple client-secret JWT)                                                                                |
| `APPLE_PRIVATE_KEY`     | secret        | no       | Reserved (ES256 `.p8` key that signs the Apple client-secret JWT)                                                 |
| `DEV_ROUTES_ENABLED`    | dev only      | no       | `"1"`: dev-only stubs (`/api/dev/*`, stub OAuth, payments stub, dev admins) on dev hosts. **Never in production** |
| `OAUTH_STUB`            | var           | no       | With `DEV_ROUTES_ENABLED=1`: `"1"` stubs on any host, `"0"` never. Unset: only on dev hosts                       |
| `ADMIN_ACCOUNT_IDS`     | var           | no       | Comma-separated account ids allowed on `/api/admin/*` (chat moderation review)                                    |
| `MODERATION`            | var           | no       | Chat moderation: `"llama-guard"` (default when `AI` is bound), `"stub"`, `"off"`                                  |
| `AI`                    | binding       | no       | Workers AI, used by chat moderation (Llama Guard). Not bound by default                                           |
| `ANALYTICS_ACCOUNT_ID`  | secret or var | no       | Admin dashboard: account id for the Analytics Engine SQL API (needs the token too)                                |
| `ANALYTICS_API_TOKEN`   | secret        | no       | Admin dashboard: API token with **Account Analytics: Read**. Absent = the dashboard reads the local stub          |
| `ANALYTICS_DATASET`     | var           | no       | Analytics Engine dataset queried by the dashboard (default `gamez_events`)                                        |
| `ANALYTICS_LOCAL`       | var           | no       | Local analytics stub (MetricsDO): `"0"` never, `"1"` always also write it, unset = dev builds only                |
| `VITE_BUILD_ID`         | build env     | no       | Client build id in client telemetry (version adoption in Tech health). Unset = `"dev"`                            |

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
`DEV_ROUTES_ENABLED === "1"` **and** (`OAUTH_STUB === "1"`, or `OAUTH_STUB` unset and the host is
`localhost`, `127.0.0.1`, `[::1]` or a tailnet `*.ts.net` name). `OAUTH_STUB=0` turns it off
everywhere. A host name alone never enables it (ADR 0012).

`/start` redirects to `/api/auth/oauth/<provider>/stub`, a small form (subject, email, name). Its
POST redirects to the callback with `code=stub:<base64url JSON>`, which carries the PKCE challenge;
the callback checks it against the cookie's verifier and makes no network calls. Stub logins are
stored as `<provider>:stub-<subject>`, so they never collide with real provider ids.

**Never set `DEV_ROUTES_ENABLED` (or `OAUTH_STUB=1`) on a public deployment**: anyone could then
sign in as any stub subject, make themselves an admin and mint currency through `/api/dev/*`.

### `DEV_ROUTES_ENABLED` (local dev only)

The one switch for every dev-only stub: `/api/dev/*` (grants, dev admins, fixtures, metric
seeding), the stub OAuth provider, the payments stub and dev-admin rights. Without `"1"` every
`/api/dev/*` path answers 404 on every host, tailnet names included. `cloudflare.config.ts`
declares it (`bindings.secret()`) only when the config is evaluated in a non-production,
non-preview mode (`vp dev`), so local `.dev.vars` can set it. Production builds and deploys
neither declare nor read it. `apps/game/.dev.vars.example` sets it to `1`. Every
`POST /api/dev/admin/self` grant logs a `{"event":"dev_admin_grant",…}` line.

## Per-IP rate limits (bindings, no secret)

`GUEST_LIMITER` (20 `POST /api/guest` per IP per minute) and `CHAT_CONNECT_LIMITER` (60 `/ws/chat`
upgrades per IP per minute) are Cloudflare Rate Limiting bindings in `cloudflare.config.ts`
(`IP_LIMITS`). They need no secret or resource. Keys are salted IP hashes derived from
`AUTH_SECRET`, so no raw IP is used as a key. With `DEV_ROUTES_ENABLED=1`, loopback and
header-less callers are not counted, which keeps local e2e and bots working (ADR 0012).

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
do not reach `env` in local dev (**verified**, see "Local development: which keys reach `env`"
under Payments). If a `.dev.vars` entry such as
`GOOGLE_CLIENT_ID` seems ignored, declare it as `bindings.secret()` in `cloudflare.config.ts`
(a declared secret that is missing only produces a local warning).

## Payments (wave C)

Money in, through one `PaymentProvider` interface (`apps/game/src/server/payments/`). Each provider
is **enabled only when its keys are set**; a provider without keys is listed as `enabled: false`
and the store never offers it. Webhooks are verified before anything is read from them; a bad
signature answers 401 and changes nothing. Fulfilment is idempotent by order id, so a replayed
webhook is a no-op. Routes: `POST /api/pay/webhook/<provider>` (see the URLs below).

| Name                         | Kind   | Required   | Enables                                                                                       |
| ---------------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`          | secret | for Stripe | Stripe Checkout Sessions and refunds (`sk_test_…` or `sk_live_…`)                             |
| `STRIPE_WEBHOOK_SECRET`      | secret | for Stripe | Verifies `Stripe-Signature` (`whsec_…`, one per webhook endpoint). Stripe is off without it   |
| `ASAAS_API_KEY`              | secret | for Asaas  | Asaas API key, sent as `access_token`                                                         |
| `ASAAS_WEBHOOK_TOKEN`        | secret | for Asaas  | The token you type into the Asaas webhook; compared with `asaas-access-token` (constant time) |
| `ASAAS_ENV`                  | var    | no         | `production` selects the live API. Anything else (or unset) uses the sandbox                  |
| `MERCADOPAGO_ACCESS_TOKEN`   | secret | for MP     | Checkout Pro preferences, payment lookup and refunds (`TEST-…` or `APP_USR-…`)                |
| `MERCADOPAGO_WEBHOOK_SECRET` | secret | for MP     | Verifies `x-signature` (the "secret signature" of the MP webhook configuration)               |
| `PAYMENTS_STUB`              | var    | no         | Needs `DEV_ROUTES_ENABLED=1`. `"1"`: stub on any host. `"0"`: never. Unset: dev hosts only    |
| `PUBLIC_ORIGIN`              | var    | no         | Origin used for return URLs and webhook URLs (default: the request origin)                    |

`AUTH_SECRET` also signs the stub's webhooks (see "Local stub" below).

### Webhook URLs to configure

Replace `<origin>` with the public origin of the deployment (`PUBLIC_ORIGIN`):

| Provider     | Configure in the provider's dashboard                                                     | Events we act on                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Stripe       | Developers → Webhooks → endpoint `<origin>/api/pay/webhook/stripe`                        | `checkout.session.completed`, `checkout.session.async_payment_succeeded` (paid), `charge.refunded` (refunded) |
| Asaas        | Integrations → Webhooks → `<origin>/api/pay/webhook/asaas`, token = `ASAAS_WEBHOOK_TOKEN` | `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED` (paid), `PAYMENT_REFUNDED` (refunded)                                 |
| Mercado Pago | Your application → Webhooks → `<origin>/api/pay/webhook/mercadopago`, topic "payments"    | `payment` (we read the status from `GET /v1/payments/<id>`)                                                   |

Checkout sends the browser back to `<origin>/#store=paid&order=<id>` or `<origin>/#store=cancel`.
The success page is not proof of payment: the webhook is.

### Paid amount check

A verified paid webhook grants the order only when the provider-reported charge equals the price
stored on the order, in currency and minor units, and comes from the order's own provider
(`account/purchases.ts`, `payments/amount.ts`). Each provider reports the charge differently:

| Provider     | Field read                                        | Conversion to minor units                                        |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| Stripe       | session `amount_total` + `currency` (`"usd"`)     | already the smallest unit (USD/BRL/EUR: cents); code upper-cased |
| Asaas        | `payment.value` (decimal reais), never `netValue` | exact decimal parse x 100; the account is BRL only               |
| Mercado Pago | `transaction_amount` + `currency_id` from the API | exact decimal parse x 100 (installment interest is not included) |
| Stub         | `amountMinor` + `currency` in the signed body     | as is; `/api/pay/stub/complete` fills them from the order        |

Anything else (another amount, another currency, another provider, or a value we cannot convert
exactly, such as `4.905`) marks the order `failed` and grants nothing. The order keeps the reported
charge (`paid_currency`, `paid_minor`) and a `fail_reason` such as
`amount_mismatch: paid BRL 0.01, the order is BRL 4.90`. Both reach D1 (`purchase` table, migration 0011) and show in the admin player lookup ("Purchases", Reason column); the Worker also logs
`store: <provider> order <id> failed: <reason>`. The webhook answers 200
(`{applied: false, status: "failed", reason}`) so the provider stops retrying, and the player gets a
`store.failed` notice. `failed` is terminal: a later delivery, even with the right amount, replays
it. Refund the payment in the provider's dashboard; its refund webhook moves the order to
`refunded` (nothing to revoke, nothing was granted).

### Stripe

1. Dashboard → Developers → API keys: copy the secret key into `STRIPE_SECRET_KEY`. Use the test
   key (`sk_test_…`) first; test cards are listed in Stripe's docs.
2. Developers → Webhooks → add the endpoint above, events as listed. Copy its signing secret
   (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
3. Local testing against Stripe needs the Stripe CLI (`stripe listen --forward-to
   localhost:5173/api/pay/webhook/stripe`), which prints its own `whsec_…` for local delivery.
   **Unverified** in this repo: nothing here has been run against Stripe's sandbox.
4. Stripe refunds use the checkout session id to find the payment intent. A `charge.refunded`
   webhook without our metadata is resolved through that payment intent's metadata (`orderId`,
   `accountId`), which checkout sets via `payment_intent_data[metadata]`.

### Asaas

1. Sandbox first: create the sandbox account at `sandbox.asaas.com`, copy the API key into
   `ASAAS_API_KEY`, and leave `ASAAS_ENV` unset (sandbox API: `api-sandbox.asaas.com/v3`).
2. Integrations → Webhooks: URL above, a random token of your own for `ASAAS_WEBHOOK_TOKEN`
   (Asaas sends it back in `asaas-access-token`). Choose the payment events.
3. Production: set `ASAAS_ENV=production` and a production key. Brazil only (BRL).
4. Payers choose PIX, boleto or card on the invoice page (`billingType: UNDEFINED`).
   **Unverified** end to end: the customer is created without CPF, so boleto may need the payer
   to fill it in on the invoice page.

### Mercado Pago

1. Developers → your application → Credentials: copy the **test** access token
   (`TEST-…`) into `MERCADOPAGO_ACCESS_TOKEN`, then the production token later.
2. Webhooks → configure the URL above for the `payments` topic. Copy the "secret signature" into
   `MERCADOPAGO_WEBHOOK_SECRET`. We check `x-signature` (`ts` + `v1`, HMAC-SHA256 of
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`), reject timestamps older than 5 minutes,
   then read the payment from the API (the body is never trusted).
3. Currencies: BRL, and USD where the account allows it. Other LatAm countries are routed here
   (AR, MX, CO, CL, PE, UY) and must match the account's currency. **Unverified** outside Brazil.

### Local stub (sandbox)

Enabled only with `DEV_ROUTES_ENABLED=1`, then on localhost, `127.0.0.1`, `[::1]` and `*.ts.net`
hosts (or any host with `PAYMENTS_STUB=1`). `GET /api/store` lists it as `stub`. Checkout opens
`/api/pay/stub/checkout?order=…&account=…`, a page with **Pay (sandbox)** and **Cancel**. Paying
posts to `/api/pay/stub/complete`, which signs the webhook body with HMAC-SHA256 keyed by
`AUTH_SECRET` (`x-stub-signature`) and runs the same verification as a real provider. Nothing
leaves the Worker. The stub is never on a public host unless `PAYMENTS_STUB=1` is set, which
must not happen on a public deployment.

To try it: sign in (any guest works to look, an account is needed to buy), open the store, choose
a pack, Pay (sandbox). The e2e feature `payments` does the same flow end to end.

### Setting these on the deployed Worker

Secrets go through `cf` like the others (see "Setting secrets with `cf`" above). The keys are
read from `env` at request time, so a new secret takes effect without a redeploy **unverified**
on Workers Builds (same open question as `AUTH_SECRET`).

### Local development: which keys reach `env`

**Verified (live probe, 2026-10-28): undeclared `.dev.vars` keys do not reach `env` in `vp dev`.**
`cloudflare.config.ts` declares only `AUTH_SECRET` as a `bindings.secret()`, and only declared
secrets are mapped from `.dev.vars` (`resolveLocalBindings` in `@cloudflare/vite-plugin`
2.0.0-beta.v.5).

How it was checked, without touching the shared `.dev.vars` of the :5173 server: a separate
`vp dev --mode qaprobe --port 5418` reads `apps/game/.dev.vars.qaprobe` instead (the plugin picks
`.dev.vars.<mode>` first, and the :5173 server only watches `.dev.vars` and
`.dev.vars.development`). That file held `AUTH_SECRET=<probe value>`, `PAYMENTS_STUB=0` and
placeholder `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`. Results:

- the guest token from `POST /api/guest` was signed with the probe's `AUTH_SECRET` (declared key:
  read);
- `GET /api/store` still listed the stub as enabled on localhost (undeclared `PAYMENTS_STUB=0`:
  not read) and Stripe as disabled (undeclared Stripe keys: not read).

The probe file was deleted afterwards. The same holds for `OAUTH_STUB`, `ADMIN_ACCOUNT_IDS`,
`MODERATION` and the OAuth client keys. To use any of them locally, declare it in
`apps/game/cloudflare.config.ts` (`bindings.secret()`; a declared secret that is missing only logs
a "Missing required secrets" warning), or set it as a `bindings.text(...)` var. The stub needs no
key beyond `AUTH_SECRET`, which is declared.

### Known gaps (wave C)

- Refunds set `revoked_at` on the order's rows in the AccountDO `entitlements` table. The column
  is added by `account/purchases.ts` (guarded `ALTER TABLE`, only when missing); the table itself
  belongs to `account/economy.ts`. `economy.ts` (`cosmetics()`, `entitlements()`) and
  `account/pass.ts` (premium) do not filter `revoked_at IS NULL` yet, so a refunded cosmetic or pass
  stays usable until they do. Gems are debited on refund (down to 0 at most).
- Stripe `charge.refunded`: a partial refund (`refunded: false`) is ignored; a full refund reads our
  ids from the payment intent (`GET /v1/payment_intents/<id>`) because charges do not carry the
  intent's metadata. **Unverified** against Stripe itself.
- The paid amount check (above) compares the charge before discounts are possible: we never create
  Stripe promotion codes or Asaas discounts. If they are ever added, a discounted order fails until
  the order stores the discounted price.

## Admin dashboard analytics

`docs/design/admin-dashboard.md` §4. The Worker writes high-volume events to the Workers Analytics
Engine dataset bound as `ANALYTICS` (`gamez_events`, created on first write; nothing to set up).
Reading them back needs the SQL API, which is not a binding:

1. Dashboard → My Profile → API Tokens → Create token → custom, permission **Account → Account
   Analytics → Read**, scoped to the gamez account.
2. Set `ANALYTICS_API_TOKEN` (secret) and `ANALYTICS_ACCOUNT_ID` (the account id) on the Worker.
3. Leave `ANALYTICS_LOCAL` unset. With both credentials present the local stub turns off and the
   dashboard's source chips say "Analytics Engine" instead of "local stub".

Without the credentials, a local `vp dev` (a dev build) also writes the points to the MetricsDO
"local" stub (14 days, 200 000 rows) and the dashboard reads that. A production build never writes
the stub by default (every write would be an RPC to one global DO); set `ANALYTICS_LOCAL = "1"` to
force it, for example for a short test without AE credentials. Without credentials and without the
stub, the dashboard's Analytics Engine sections read the (empty) stub. The SQL
dialect the dashboard sends (`FORMAT JSON`, `quantileExactWeighted`, `intDiv(toUInt32(timestamp))`)
is **unverified against the live API** until it runs with real credentials (ADR 0008).

`VITE_BUILD_ID` is a build-time variable (Workers Builds → build variables, e.g. the commit SHA):
it labels client telemetry so Tech health shows version adoption.

## Never

- Never commit real values, and never put them in `cloudflare.config.ts` as `text(...)` unless
  they are public (client ids).
- Never invent keys in docs or tests: tests use obviously fake values (`gid`, `gs`).
- Never enable the stub provider (`OAUTH_STUB=1`) on a public host, and never set
  `DEV_ROUTES_ENABLED` outside local `.dev.vars`.
