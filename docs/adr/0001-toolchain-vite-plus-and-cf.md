# ADR 0001: Toolchain is Vite+ (`vp`) plus the `cf` CLI

- Status: accepted (phase 0)
- Date: 2026-10-27

## Context

gamez is a pnpm monorepo (apps, packages, modules, tools) whose game is one Cloudflare Worker: the Pixi client as Workers static assets, the API, three SQLite Durable Objects, a D1 read model and a Queue. We want one dev loop for client and server, fast lint/format/type checks, and the current Cloudflare CLI rather than Wrangler.

## Decision

- **Vite+ (`vp` 1.4.0)** for everything JS: `vp dev` / `vp build` (Vite 8.3 on Rolldown), `vp test` (Vitest 5.0.5, test APIs imported from `vite-plus/test`), `vp check` (Oxfmt 0.74 + Oxlint 1.89 with type-aware rules and type checking through tsgolint), and `vp run` as the cached task runner. pnpm 12.15 workspaces underneath, TypeScript 7.0.
- **`@cloudflare/vite-plugin` (2.0.0-beta)** runs the Worker and all DOs inside workerd during `vp dev`, so the client and server share one process and one port.
- **`cf` (1.0.0-beta.23)** for Cloudflare config (`apps/game/cloudflare.config.ts`), deploys and resources. No Wrangler config exists in this repo.
- **CI**: GitHub Actions runs `vp check`, `vp run -r test`, `vp -C apps/game build` and the e2e. Deploys go through Workers Builds (`docs/deploy.md`).

## Consequences and gotchas found in phase 0

- **Use the workspace `vp`.** On this machine the global `vp` comes from mise's npm backend, which runs its own copy of Vitest instead of delegating to the repo's. Every suite then fails with `Cannot read properties of undefined (reading 'config')` or "Vitest failed to find the current suite", because the test file and the runner load different Vitest instances. `node_modules/.bin/vp` (or the official global CLI that `setup-vp` installs in CI, which delegates to the local install) works. This is an environment issue, not a repo issue.
- **TypeScript 7 defaults `types` to `[]`.** A package that needs Node globals must say `"types": ["node"]` (see `tools/e2e/tsconfig.json`); the game uses `["@cloudflare/workers-types"]`.
- **Tools run by plain Node** (`node file.ts`, type stripping) cannot use TypeScript-only runtime syntax such as constructor parameter properties or enums. Our packages avoid them, so `tools/e2e` imports workspace TS source directly.
- **`vp run` caches package scripts** (`run.cache: true`). Anything with side effects outside its inputs (the e2e, local migrations) is defined as a root task with `cache: false` in `vite.config.ts`.
- **Local D1 and `cf`.** `cf d1 migrations apply/query` accept only a database UUID. The dev server keys its local D1 by the binding id (`DB-gamez`) while the binding has no `id`, so `cf --local` cannot reach it. Phase 0 applies migrations to the dev server's D1 through the Cloudflare Vite plugin's local explorer API (`vp run migrate-local`). Once the production database exists, put its id in `bindings.d1({ … id })` and switch to `cf d1 migrations apply <id> --local --persist-to apps/game/.cloudflare/state`.
- Vitest 5 has no top-level `bench`; benchmarks are `test("…", async ({ bench }) => …)` and run with `vp test bench --run --reporter=verbose`.
