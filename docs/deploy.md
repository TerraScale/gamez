# Deploy runbook

Production deploys run through **Cloudflare Workers Builds** (Cloudflare's GitHub integration), not GitHub Actions. GitHub Actions (`.github/workflows/ci.yml`) only checks, tests and builds.

- Pull requests: Workers Builds creates a Preview for each PR (and comments on it).
- `main`: Workers Builds deploys production.

Resources: Worker `gamez` (static assets plus `RelayDO`, `ChunkDO`, `CharacterDO`), D1 `gamez-read`, queue `gamez-sync` (consumer on the same Worker), secret `AUTH_SECRET`. Config lives in `apps/game/cloudflare.config.ts`.

Everything below was checked against `cf <command> --help` on `cf` 1.0.0-beta.20 unless marked **unverified**. Nothing here has been run.

## 0. Before you start

- Commit the repo and push it to `TerraScale/gamez` `main`, including `pnpm-lock.yaml`. Workers Builds and CI need the lockfile on GitHub.
- Log in with `cf auth` (or set the usual Cloudflare credentials). Use `--profile` if you have several.
- `cf d1 create` and `cf queues create` are mutating. Run them once, by hand, for the account.

## 1. Create the D1 database

```sh
cf d1 create --name gamez-read
```

Optional flags: `--primary-location-hint <wnam|enam|weur|eeur|apac|oc>`, `--jurisdiction <eu|fedramp|us>`, `--read-replication-mode <auto|disabled>`. Save the database ID from the output (the output format is **unverified**). To look it up later, use `cf d1 list`.

## 2. Create the queue

```sh
cf queues create --queue-name gamez-sync
cf queues create --queue-name gamez-sync-dlq
```

`gamez-sync-dlq` is the dead-letter queue for `gamez-sync`. Messages land there after 10 failed deliveries. Nothing else in the repo creates it, so create it with the command above.

`cf queues consumers create <queue-id>` creates a consumer, but its flags are **unverified**. `cf deploy` provisions missing bindings by default (`--provision`, default `true`), so the consumers may be created on first deploy. Check after the first deploy with `cf queues consumers list`. Two consumers must exist: `gamez-sync` (batch size 4, retry delay 10 s) and `gamez-sync-dlq` (batch size 4, 100 retries, retry delay 900 s). Both are declared in `apps/game/cloudflare.config.ts`.

### Draining the DLQ

The `gamez-sync-dlq` consumer runs the same `consumeSyncBatch` as `gamez-sync`. It re-applies each dead-lettered batch (applying is idempotent and version-guarded) and logs every failure at error level as `sync: DLQ apply failed`, with `source` and `records`. Failed batches are retried every 15 minutes, up to 100 times, and are then dropped. To check the backlog, use `cf queues list` (message counts are **unverified**). Alert on `sync: DLQ apply failed` in the Worker logs. A growing DLQ means D1 cannot take the writes, so fix the cause before the 100 retries run out.

### Free plan

The free plan allows 50 D1 queries per invocation, not 1000. A message with `n` records costs `n + 1` statements, so one invocation must stay within 50. Lower these before deploying on the free plan:

- `maxBatchSize` for `gamez-sync` and `gamez-sync-dlq` to `1`.
- `FLUSH_BATCH` in the Durable Objects (`200` in `do/*.ts`) to `48` or less, so each message costs at most 49 statements.
- `SYNC_STATEMENT_BUDGET` in `apps/game/src/server/sync-consumer.ts` to `49`.

## 3. Apply D1 migrations (remote)

`cf d1 migrations apply` takes the database ID and has no local/remote switch. It always targets the remote database. `--local` is a global flag for local simulation and must not be used here. Run from `apps/game` so the default `./migrations` directory resolves, or pass `--dir apps/game/migrations`.

```sh
cd apps/game
cf d1 migrations list <DATABASE_ID>      # read-only: shows unapplied files
cf d1 migrations apply <DATABASE_ID>     # tracks state in table d1_migrations
```

Add `--dry-run` to see the command without executing it.

## 4. Set the `AUTH_SECRET` secret

```sh
cf workers secrets update AUTH_SECRET --worker gamez --text "<value>"
cf workers secrets get AUTH_SECRET       # confirms the binding; the value is omitted
```

`--text` puts the value in shell history. Prefer a `.env` or JSON file passed to `cf deploy --secrets-file <path>` (verified flag). Whether a later Workers Builds deploy keeps a secret set this way is **unverified**; check `cf workers secrets get` after the first production deploy.

## 5. Connect the GitHub repo to the Worker

### 5a. Authorize GitHub (dashboard, one time)

The first GitHub connection needs OAuth authorization in the dashboard (Workers & Pages, then Create application, then GitHub). The exact path for an existing Worker is **unverified**; see the docs at `https://developers.cloudflare.com/workers/ci-cd/builds/`.

### 5b. Gather IDs (read-only)

```sh
gh api repos/TerraScale/gamez --jq '{repo_id: .id, owner_id: .owner.id, owner: .owner.login}'
```

The Worker "script tag" (the external script ID that Workers Builds uses, not the name) is needed for `--script-tag`. How to get it from the CLI is **unverified**. Try `cf workers get gamez` and the dashboard. `cf builds workers get <script-tag>` returns the current config once you have the tag.

### 5c. Connect the repo and enable previews

Dry-run first (`--dry-run` is a verified flag), then drop it to apply:

```sh
cf builds workers create \
  --script-tag <SCRIPT_TAG> \
  --git-repository-provider-type github \
  --git-repository-provider-account-id <OWNER_ID> \
  --git-repository-provider-account-name TerraScale \
  --git-repository-repo-id <REPO_ID> \
  --git-repository-repo-name TerraScale/gamez \
  --git-repository-branch main \
  --previews-enabled \
  --previews-base-config-root-directory / \
  --previews-base-config-build-command "pnpm exec vp -C apps/game build" \
  --previews-base-config-deploy-command "pnpm -C apps/game exec cf deploy" \
  --production-settings-root-directory / \
  --production-settings-build-command "pnpm exec vp -C apps/game build" \
  --production-settings-deploy-command "pnpm -C apps/game exec cf deploy" \
  --dry-run
```

Notes:

- Root directory `/` runs the install at the workspace root (needed for the pnpm workspace). Build and deploy then run from `apps/game` through `-C` and `pnpm -C`.
- The install command is not a flag on `cf builds workers create`. Workers Builds is expected to detect pnpm from the lockfile and run `pnpm install --frozen-lockfile` (**unverified**). Check the dashboard build settings after connecting.
- `cf deploy` builds the project itself (`cf deploy --dry-run` "builds a project and runs checks"), so the build command may be redundant. Keep it only if the Workers Builds log shows the build is needed separately.
- `--previews-base-config-build-token-uuid` and `--production-settings-build-token-uuid` need a build token. `cf builds tokens create` exists, but the flow for getting a token UUID into this call is **unverified**. Creating the connection in the dashboard is simpler.
- Workers Builds build minutes: `cf builds limits` shows availability.

Admin dashboard (`docs/design/admin-dashboard.md`, `docs/secrets.md` "Admin dashboard analytics"):

- Set the build variable `VITE_BUILD_ID` (for example the commit SHA) in both the preview and production build settings, so client telemetry reports the build.
- Optionally set `ANALYTICS_ACCOUNT_ID` and `ANALYTICS_API_TOKEN` (Account Analytics: Read) so the dashboard reads Analytics Engine instead of the local stub. The `gamez_events` dataset is created on first write.
- Apply migration `0010_admin.sql` with the others (step 3).

### 5d. Verify

```sh
cf builds workers get <SCRIPT_TAG>
cf builds list --external-script-id <SCRIPT_TAG>   # build history for the Worker
```

Open a PR and check that a Preview build runs. Merge to `main` (or run a production build) and check the production deploy.

## 6. Local deploy (only if needed)

```sh
cd apps/game
cf deploy --dry-run                      # build and checks, no upload
```

A real `cf deploy` uploads to the account. Use it only when you mean to deploy outside Workers Builds.

## Open questions

- Confirm the GitHub repo connection and Preview setup in the dashboard before the first PR.
- Decide whether `--provision` stays on, so `cf deploy` creates missing D1 and queue resources, or whether all resources are created by hand.
- Decide whether `AUTH_SECRET` is set once by hand or passed from a secrets file on each deploy.
