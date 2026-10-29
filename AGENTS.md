# AGENTS.md — building gamez

This guide is for anyone (human or AI agent) adding **modules**, **game modes** and **game feature systems** to gamez. Read it before writing code. The architecture plan behind it is in `docs/adr/` and the root `README.md`.

> **gamez** is a web-first 2.5D isometric idle RPG that runs entirely on Cloudflare: Workers, SQLite Durable Objects, D1, Queues, R2 and Workers static assets.
> The engine is a thin **kernel**. **Every game rule lives in a module.** A **game mode** is a set of modules plus its own world.
> The default mode, `classic`, is a Diablo-like ARPG. The test modes `steps` (step-based roguelike) and `duel` (turn-based creatures) show that a mode can replace anything.

---

## 1. Golden rules

1. **Everything is a module.** If you're writing game logic in `apps/game` or `packages/kernel`, stop: it belongs in a module under `modules/`. The kernel only provides mechanics: loading, registries, ECS, scheduling, RNG and overrides.
2. **Sim code is deterministic.** The same seed and the same actions must give the same `sim.hash()` on every JS engine, because the client predicts with the exact code the server verifies with (§6).
3. **The server is authoritative.** Clients send _intents_ (actions). Durable Objects decide. D1 is a **read model** that is never used for gameplay decisions.
4. **Use logical ids, never files.** Code refers to `unit.hero.walk.ne` and `tile.grass`, never to `hero.png`. Art is swapped through manifests.
5. **Use original IP only.** No Pokémon, Digimon or other franchise names, creatures, moves or art.
6. **Write contracts first.** Shared types and interfaces get written and agreed before parallel work starts. Change a contract on purpose, never by accident.
7. **Back choices with benchmarks.** Start from a sensible default, measure in `tools/bench`, and record the decision in `docs/adr/`. Nothing waits on a benchmark, but every important choice cites one.
8. **Everything ships green.** `vp check`, every test and the e2e test must pass before work counts as done.

---

## 2. Repo map

```
apps/game/                 The one Worker: API + Durable Objects + static client (Vite + @cloudflare/vite-plugin)
  cloudflare.config.ts     cf config: DOs, D1, queues, assets, secrets
  migrations/              D1 SQL migrations (read model)
  src/server/              Worker, DOs (relay, chunk, character, instance, account, identity, chat, guild; wave C:
                           escrow, market, plots, shop, arena, config), projections
    routes/                One file per feature and path prefix (auth, account, vault, trade, market, shops, arena, …)
    instance/              InstanceHost (event-ticked modes) and VerifiedHost (client-driven classic)
    auth/ account/ chat/ guild/ presence/ leaderboards/   Pure logic behind the DOs and routes (unit-tested)
    trade/ market/ shops/ arena/ payments/ admin/ economy/ config/   Wave C logic (custody sagas, providers, flags)
  src/client/              React app shell, mode views (lazy chunks), net, Pixi renderer, platform SDK, verified + presence connections
  src/shared/catalog.ts    THE module catalog + list of modes (shared by client and server)
packages/
  kernel/                  Module loader, registries, ECS, sim, RNG, overrides  ← read its README
  protocol/                Wire messages (presence + instance), JSON and binary codecs
  sync/                    Transactional outbox → Queue → version-guarded D1 apply
  world/                   TileMap, iso math, A* pathfinding, walk interpolation
  assets/                  Asset manifest types, mergeManifests, resolveId fallback
  ui-host/                 Client SDK for modes: ClientModeView, ClientServices, InstanceConnection, UI slots, renderer contract
modules/
  classic/                 The classic idle ARPG (@gamez/mode-classic): sim modules in src/, client in src/client/,
                           verified-host hooks + bank + vault codec + arena build + season total in src/platform/
  economy/                 @gamez/economy: pure economy rules (fees, market, leases, rating, seasons, products, telemetry)
  arena/                   @gamez/mode-arena: deterministic async arena fight() + ArenaScreen/ArenaReplay (./client)
  classic.town/            Town Plaza map (content)
  art.kenney/              Starter CC0 art pack → apps/game/public/art/kenney/
  steps/  duel/            Test modes (also the regression suite for the module system)
tools/
  e2e/                     End-to-end tests against a real local `vp dev`
  qa/                      Browser QA harness (headless Chrome over CDP): scenarios + screenshots
  bench/                   Benchmarks (results in docs/bench/)
  loadtest/                Presence bot swarm with private server state (results in docs/bench/)
apps/native/               Capacitor + Electron shells (not workspace packages; docs/ship.md)
docs/adr/                  Architecture decision records
docs/design/               Designs (classic.md, wave-A/B/C.md): the binding spec for builders
```

---

## 3. Commands

> ⚠️ Use the **workspace** binary `node_modules/.bin/vp`. The global `vp` on some machines runs its own Vitest copy, so every test suite fails with `Cannot read properties of undefined (reading 'config')`.

| What                                                | Command (from repo root)                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Install                                             | `node_modules/.bin/vp install`                                                   |
| Format + lint + typecheck                           | `node_modules/.bin/vp check` (`--fix` to format)                                 |
| All tests                                           | `node_modules/.bin/vp run -r test`                                               |
| One package's tests                                 | `node_modules/.bin/vp test run modules/steps`                                    |
| Dev server (client + Worker + DOs, local D1/queues) | `node_modules/.bin/vp run dev`                                                   |
| Apply D1 migrations to local dev                    | `node_modules/.bin/vp run migrate-local`                                         |
| End-to-end                                          | `node_modules/.bin/vp run e2e` (starts and stops its own dev server)             |
| Browser QA (against a running dev server)           | `node tools/qa/src/run.ts classic-idle warrior 2 8` (see `tools/qa/README.md`)   |
| Production build                                    | `node_modules/.bin/vp -C apps/game build`                                        |
| Cloudflare CLI                                      | `cf …`. Discover commands with `cf cli search "<task>"`. **Never use wrangler.** |

Deploys go through Cloudflare Workers Builds from GitHub (`docs/deploy.md`). Never deploy by hand unless asked to.

---

## 4. Architecture in 60 seconds

```
client ──WS /ws──────────► RelayDO (near player) ──► ChunkDO (shared presence: who is where, walking where)
   │                                                        │ fan-out once per relay
   └──WS /ws/instance────► InstanceDO "<mode>:<account>" (runs a kernel Sim for instanced modes)
                         CharacterDO "<account>:<mode>" (authoritative character state)
client ──HTTP /api/*, WS /ws/chat──► AccountDO "<account>", IdentityDO "<login>", ChatChannelDO "<channel>", GuildDO "<slug>"
DO SQLite (truth) ── transactional outbox ──► Queue ──► D1 (read model: leaderboards, market search, admin)
```

- **Presence is shared and simulation is sharded.** The overworld only broadcasts _where avatars are and what they visibly do_. Combat, loot and progress run per player (or per instance), so the cost stays flat as worlds get crowded.
- **PvE is ping-independent.** The client runs the module sim locally for instant feedback, and the server re-runs it to verify. Rewards only become tradable after verification. Classic is **client-driven**: the browser streams input segments with its hash and the InstanceDO's `VerifiedHost` replays every one (ADR 0005).
- **PvP exists only in instanced arenas**, never in the overworld.
- **Each mode has its own world. The economy (wallet, universal items) is shared across modes, and characters are per mode.**

---

## 5. Kernel concepts (cheat sheet)

| Concept         | What it is                                                                                                             | API                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Module**      | A unit of game logic and data with an id like `steps.combat`                                                           | `defineModule({ id, version, deps, data, dataUpdates, dataFinal, setup, systems, actions, overrides })` |
| **Mode**        | A playable game: a set of modules, a world and a tick policy                                                           | `defineMode({ id, name, description, world, modules: ["steps.*"], tick, instance })`                    |
| **Registry**    | Prototype tables (items, spells, creatures…) built in 3 stages, then frozen                                            | `reg.define / patch / remove / get / all`                                                               |
| **Data stages** | `data` (define) → `dataUpdates` (patch others) → `dataFinal` (last fixes), each run across _all_ modules in load order | Factorio model                                                                                          |
| **Component**   | Plain-JSON data attached to an entity                                                                                  | `defineComponent<T>("steps.health")`                                                                    |
| **World**       | ECS store with sorted queries and resources                                                                            | `world.create / add / update / read / peek / query / setResource`                                       |
| **System**      | Runs every tick (fixed) or after each action (event), ordered by stage → order → load order → id                       | `{ id, stage, order, run(world, ctx) }`                                                                 |
| **Action**      | A validated player intent; atomic, so any throw rolls everything back                                                  | `{ name, parse(world, payload, ctx), apply(world, p, ctx) }`                                            |
| **Override**    | Change another module's runtime behaviour                                                                              | `{ kind: "system" \| "action", target, op: "disable" \| "replace" \| "wrap" }`                          |
| **Event**       | Something observers should know about (UI, network, logs)                                                              | `ctx.emit({ type: "steps.attack", … })`                                                                 |
| **Sim**         | A running mode                                                                                                         | `createSim(loadMode(mode, catalog), { seed })` → `dispatch / step / snapshot / hash`                    |
| **contentHash** | Hash of the module set and the frozen registry; client and server must match                                           | `loaded.contentHash`                                                                                    |

Load order comes from `deps` and `optionalDeps`, with ties broken by id. Patching, wrapping and overriding apply in that order, so a later module wraps an earlier one.

`get()`/`read()` hand out live values and log a rollback copy the first time in each `dispatch()`/`step()`. In hot read-only loops (every monster, every tick) use `world.peek(e, C)`: same value, no copy. Never mutate what `peek()` returns; `update()` after a `peek()` is fine (ADR 0010 §6).

---

## 6. Determinism rules (enforced by lint + tests)

Applies to everything the kernel runs: `data*`, `setup`, systems, actions. That means all of `modules/*/src/**` except `src/client/**` and `*.tsx`.

- ❌ `Math.random`, `Date`, `performance.now`, `setTimeout` / `setInterval`, `fetch` or other I/O, `crypto.randomUUID`.
- ✅ `ctx.rng.next() / int() / chance() / pick() / shuffle()`, `ctx.tick`, `ctx.timeMs`.
- ❌ Iterating `Object.keys` of runtime data whose insertion order depends on history, or `Map`/`Set` stored in components.
- ✅ `world.query(...)` (ascending ids) and `registry.all(kind)` (sorted by id). Sort anything else explicitly.
- ❌ Class instances, functions, `undefined` fields, `NaN` or `Infinity` in components or resources.
- ✅ Plain JSON data. Integers for anything that is compared or accumulated a lot, such as HP, gold and positions.
- Reject bad input by throwing `ActionError(code, message)` in `parse`/`apply`. The kernel restores the world, RNG and tick.

**Test it:** every module must have a test where two sims with the same seed and action script produce the same `hash()`, and where the hash after a fixed script is pinned.

---

## 7. Recipe: create a new module

Example: a `steps.regen` module that heals the hero 1 HP every 5 turns, adds a monster and buffs an existing one. It uses the real `steps` APIs (`modules/steps/src/components.ts`).

**1. Decide where it lives.** Add to an existing mode package (for example `modules/steps/src/regen.ts`) or create a new package `modules/<name>/` when several modes will reuse it. For a new package, copy the shape of `packages/protocol`: `package.json` exporting `./src/index.ts`, `"test": "vp test"`, and a `tsconfig` extending `../../tsconfig.base.json`. Then run `node_modules/.bin/vp install`.

**2. Write the module.**

```ts
import { ActionError, defineComponent, defineModule } from "@gamez/kernel";
import {
  Actor,
  Health,
  Player,
  Position,
  chebyshev,
  heroEntity,
  type MonsterProto,
} from "@gamez/mode-steps"; // inside modules/steps use "./components.ts"

// Components are owned by the module that defines them; others import the handle.
export const Regen = defineComponent<{ every: number; amount: number }>("steps.regen");

export const regenModule = defineModule({
  id: "steps.regen",
  version: "1.0.0",
  deps: ["steps.core", "steps.combat"], // must load first and be in the mode

  data(reg) {
    // New content: an original monster.
    reg.define<MonsterProto>("steps.monster", "steps.mirelurk", {
      name: "Mirelurk",
      hp: 7,
      dmg: 2,
    });
  },
  dataUpdates(reg) {
    // Patch another module's prototype instead of copying it.
    reg.patch<MonsterProto>("steps.monster", "steps.gloomcap", (m) => {
      m.hp += 2;
    });
  },

  setup(world) {
    for (const e of world.query(Player)) world.add(e, Regen, { every: 5, amount: 1 });
  },

  systems: [
    {
      id: "steps.regen.tick",
      stage: "post",
      run(world, ctx) {
        for (const e of world.query(Regen, Health)) {
          const r = world.read(e, Regen);
          if (ctx.tick % r.every !== 0) continue;
          const h = world.read(e, Health);
          if (h.hp >= h.max) continue;
          world.update(e, Health, { hp: Math.min(h.max, h.hp + r.amount) });
          ctx.emit({ type: "steps.regen", entity: e, amount: r.amount });
        }
      },
    },
  ],

  actions: [
    {
      name: "steps.rest",
      parse(_world, payload) {
        if (payload !== undefined && (payload === null || typeof payload !== "object"))
          throw new ActionError("bad_payload", "expected {}");
        return {};
      },
      apply(world, _p, ctx) {
        const hero = world.read(heroEntity(world), Position);
        const threatened = world
          .query(Actor, Position)
          .some(
            (e) =>
              world.read(e, Actor).kind === "steps.monster" &&
              chebyshev(world.read(e, Position), hero) <= 1,
          );
        if (threatened) throw new ActionError("not_safe", "Enemies nearby");
        ctx.emit({ type: "steps.rest" });
      },
    },
  ],
});
```

**3. Add it to a mode.** Either list it in the mode's `modules` (globs such as `"steps.*"` pick it up automatically) and export it from the package's `modules` array, or add it to a different mode.

**4. Register the package** in `apps/game/src/shared/catalog.ts` (`MODULE_CATALOG`, plus `MODES` if it adds a mode) and as a dependency of `apps/game`.

**5. Write the tests** (`modules/<pkg>/tests/*.test.ts`, importing from `"vite-plus/test"`):

- Behaviour, through `createSim(loadMode(mode, catalog), { seed })` and `sim.dispatch(...)`.
- Determinism: same seed and script give the same hash. Pin the hash after a fixed script.
- Rejection: invalid actions return `ok: false` and leave `sim.hash()` unchanged.
- Interplay: the module still works when the modules it overrides or patches are present.

**6. Client view (optional):** see §10.

### Naming

- Module ids are `<mode-or-domain>.<feature>`: `steps.combat`, `economy.market`, `arpg.classes`.
- Systems, actions, components, events, registry kinds and resources are all **prefixed with the module's namespace**: `steps.regen.tick`, `steps.rest`.
- Versions are semver. Bump when data or behaviour changes, because that changes `contentHash` and invalidates persisted instances (they restart with `content_changed`).

---

## 8. Recipe: change another module's behaviour

Prefer the lightest tool that works.

| Need                                    | Use                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tweak numbers or content                | `dataUpdates`: `reg.patch(kind, id, fn)`                                                        |
| Remove content                          | `reg.remove(kind, id)` in `dataUpdates` or `dataFinal`                                          |
| Add behaviour around a system or action | `overrides: [{ kind: "system", target, op: "wrap", with: (w, ctx, next) => { …; next(); … } }]` |
| Change a rule completely                | `op: "replace"`                                                                                 |
| Turn a rule off                         | `op: "disable"`                                                                                 |

```ts
overrides: [
  // Double damage on critical turns, keeping the original logic.
  {
    kind: "action",
    target: "steps.move",
    op: "wrap",
    with(world, payload, ctx, next) {
      next(payload);
      if (ctx.rng.chance(0.1)) ctx.emit({ type: "steps.crit" });
    },
  },
],
```

Overrides that target an unknown id fail loudly at load time. Declare the target module in `deps`, so that you load after it.

---

## 9. Recipe: create a new game mode

1. Create `modules/<mode>/` exporting `modules: ModuleSpec[]`, `mode: ModeSpec`, and `./client` exporting a `ClientModeView`.
2. Choose a **tick policy**:
   - `{ kind: "event" }` for turn- or step-based modes. Systems run after each successful action.
   - `{ kind: "fixed", hz }` for real-time modes.
   - A fixed-tick mode that must run in the browser without lag adds `instance.clientDriven` (`ClientDrivenPolicy`: segment limits, `speedOf`, `maxSpeed`, `serverOnlyActions`, offline progress, `reports`). The InstanceDO then verifies it with `VerifiedHost`. Copy `modules/classic/src/platform/policy.ts`.
3. Choose a **world**:
   - `world: null` for instance-only modes. They run in `InstanceDO "<mode>:<accountId>"`.
   - `world: "<id>"` for a persistent shared world. That uses presence, the chunks and the relay.
4. Put **party size and instance rules** in `instance: { maxPlayers }` and in your modules. The kernel and DOs stay generic.
5. Register it in `catalog.ts` and `client/modes/index.ts`. It shows up in the mode picker.
6. Add e2e coverage in `tools/e2e`: join, play a scripted sequence, reject an invalid action, survive a dev-server restart, and confirm that a fresh join resets.

Examples to copy: `modules/steps` (event tick, Pixi grid, keyboard and tap) and `modules/duel` (event tick, menu-driven React UI).

---

## 10. Client side: views, UI slots, art

- A mode's UI is a `ClientModeView` (`@gamez/ui-host`). `mount(host, services)` returns an unmount function.
- `services` gives you:
  - `session`
  - `manifest`, `assetBaseUrl`
  - `createWorldRenderer()` for the Pixi isometric view
  - `connectInstance(mode)`, which returns an `InstanceConnection` with `getView`, `subscribe`, `act`, `restart`
  - optional `connectVerified(mode, handlers)` for client-driven modes, `joinPresence(world)` for presence worlds, and `platform` (auth, leaderboards, chat, guilds, account). Shared React components for them are in `@gamez/ui-host` `social/`.
  - `exit()`
- **Prediction is built in.** `connection.act(name, payload)` dispatches locally on a cloned sim, shows the predicted snapshot, and reconciles with the server result. Your UI only renders `view.world`, `view.events` and `view.error`.
- **React** handles menus and panels. **Pixi** handles the world and in-world HUD (health bars, damage numbers). Keep game state out of React state: read it via `subscribe` with selectors, so 60 fps rendering never re-renders React.
- **UI slots:** modules contribute panels to named slots (`hud.left`, `panel.character`, …) through the slot registry in `@gamez/ui-host`, and can `replace` or `remove` other modules' panels.
- **Art:**
  - Request logical ids. `resolveId` falls back from `unit.hero.walk.ne` to `unit.hero.walk` to `unit.hero` to `missing`.
  - To add art, put sprites in an art pack module (see `modules/art.kenney`, which has a build script, a LICENSES file and a manifest test), or overlay a pack with `mergeManifests`.
  - Never hard-code file paths.
- **Performance budget:**
  - Targets: 60 fps on iPhone 14 / Pixel 7, and smooth on GTX 1080-class desktops with 8 GB RAM.
  - Atlases at most 2048², about 400 MB JS + GPU on mobile.
  - No per-frame allocations in hot paths, and no re-sorting when nothing moved.
- Mobile first: touch targets at least 44px, layouts that work at 375px width.

---

## 11. Server side: adding a game feature system

A "feature system" is something like professions, player shops, an auction house, guilds or a battle pass. Decide each layer explicitly.

| Question                                               | Where it goes                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Rules and content (recipes, prices, formulas)          | A **module** (`modules/economy/…`), with data in the registry and logic in actions and systems                     |
| Per-player authoritative state                         | The player's **CharacterDO** (per mode) or **AccountDO** (shared across modes: wallet, universal stash, cosmetics) |
| Shared authoritative state (a shop, a market, a guild) | **Its own DO** keyed by id (`ShopDO`, `MarketDO`, `GuildDO`). One DO is the single writer for its data.            |
| Transfers between two owners (trade, buy, mail)        | **EscrowDO** saga, idempotent by `txId`. Never "debit here, credit there" without escrow.                          |
| Search, lists, leaderboards, admin views               | A **D1 projection** fed by the outbox                                                                              |
| Wire format                                            | Extend `packages/protocol` (and both codecs), or reuse instance actions for instance modes                         |
| UI                                                     | A module client panel in a UI slot                                                                                 |

### Adding an HTTP route

Add a file in `apps/game/src/server/routes/` that returns `null` for paths it does not own, list it in `routes/index.ts`, and authenticate with `authenticateRequest` (`auth/session.ts`), never by parsing tokens yourself. Use `http.ts` (`json`, `apiError`, `readJson`) for bodies and errors.

### Adding a DO

1. Write the class in `apps/game/src/server/do/<name>.ts`, export it from `src/server/index.ts`, and add `exports.durableObject({ storage: "sqlite" })` plus a binding in `cloudflare.config.ts` and the `Env` in `contracts.ts`.
2. Write its RPC surface as an interface in `contracts.ts` first.
3. Create schema in the constructor inside `ctx.blockConcurrencyWhile`. Use hibernatable WebSockets (`ctx.acceptWebSocket`) for sockets, and alarms for timers.
4. Keep the DO a thin adapter over a logic class that takes a `SqlStore` (`sqlStoreOf(ctx.storage)`), and test that class with `apps/game/tests/support/fake-sql.ts` (real SQLite through `node:sqlite`).

### Replicating to D1 (the sync engine, `packages/sync`)

1. In the DO, write state **and** call `outbox.append(table, pk, "upsert" | "delete", payload)` inside one `ctx.storage.transactionSync`. Then call `await outbox.scheduleFlush(ctx.storage)`, and in `alarm()` call `await outbox.flush(sink)`.
2. Add a **projection** (`apps/game/src/server/projections.ts`) that maps the payload to columns.
3. Add a **migration** in `apps/game/migrations/NNNN_*.sql`:
   - The table needs a pk plus `_version INTEGER NOT NULL`, `_deleted INTEGER NOT NULL DEFAULT 0` and `_updated_at INTEGER NOT NULL`.
   - Every other column must be nullable or have a default, because tombstones insert bare rows.
4. Guarantees: at-least-once delivery, reordering and duplicates are harmless, and deletes are tombstones. Never use D1 to decide gameplay.
5. Keep a `ReplicationBatch` under the 128 KB queue message limit.

### Economy rules (from the plan)

- The economy is player-driven. NPCs only provide **sinks**: cheap low-level potions and a lowball junk buyer.
- Every faucet needs a sink. Add listing fees, taxes, rent, repairs and fees when you add new income.
- Items carry a `tradable` policy hook and a `universal` flag. Only universal items cross modes.
- Value that crosses players lives only in AccountDO (coin wallet + vault). A mode reaches it through a bank action applied by the verified host (ADR 0006 §1).
- Venues use **custody, not holds**: debit into the venue DO with txIds derived from the request `opId`, persist each saga step before its call, re-drive from the alarm, refund on failure. Keep the logic in a class taking `SqlStore`, `AccountGateway`, `Outbox` and a clock, and test it with `tests/support/fake-gateway.ts`, failing and crashing every step.
- Wallet telemetry: signed deltas tagged `faucet` / `sink` / `transfer`; a refunded sink is a positive `sink` amount.
- Writes need a registered account (`economyCaller(c, flag, { write: true })`); every feature sits behind a ConfigDO flag that fails open.

---

## 12. Testing and quality gates

| Layer        | Required                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module       | Behaviour, determinism (pinned hash), rejection of invalid actions, override and patch interplay                                                                                                                                |
| Kernel       | Covered in `packages/kernel/tests`. Any kernel change must keep **both** test modes green.                                                                                                                                      |
| Server logic | Pure helpers unit-tested. Extract DO logic into classes with a storage interface and test them with in-memory fakes.                                                                                                            |
| Sync         | Changes need chaos-style tests (shuffled, duplicated batches end in the latest state)                                                                                                                                           |
| End to end   | `tools/e2e` against real `vp dev`: plaza presence, each instance mode, persistence across restart, client graph, then the platform features (`E2eFeature`s in `tools/e2e/src/features.ts`: `run`, optional `afterRestart`)      |
| Browser      | `tools/qa` scenarios for user-visible work (screenshots at desktop and `--viewport phone`)                                                                                                                                      |
| Performance  | Relevant bench in `tools/bench`, results in `docs/bench/`, decision in `docs/adr/`. Timing asserts in tests scale with the measured machine load (`modules/classic/tests/support/perf.ts` `loadScale()`), never a bare ms bound |

Before saying something is done: `node_modules/.bin/vp check`, `node_modules/.bin/vp run -r test`, `node_modules/.bin/vp -C apps/game build` and `node_modules/.bin/vp run e2e`, all green. Report failures honestly, with output.

---

## 13. Working with AI agents (workflows)

Large work runs as **Workflows** that fan out to subagents. Model routing follows `~/Projects/AGENTS.md`:

- **Opus 5.5** (`claude-opus-5-5`) writes contracts and handles the kernel, sync, DOs, integration, review, and any task expected to take more than 10 minutes.
- **Haiku 5.5** (`claude-haiku-5-5`) handles bounded tasks against fixed contracts: a module, a codec, tests, an art pack, a bench, CI.
- Start every workflow by having an agent report its model ID, and abort if it isn't `claude-haiku-5-5`. Never fall back to Haiku 4.5, and never fall back silently.

Pattern for each phase:

1. **Contracts:** Opus writes the types and interfaces and commits them.
2. **Fan-out:** Haiku agents work in parallel. Each owns **explicit paths** and never touches others' files. Each must pass `vp check` plus its own tests.
3. **Escalation:** a Haiku agent that fails its gate is retried by Opus.
4. **Integration:** Opus wires everything together, runs every gate and the e2e, and writes the ADRs.

Brief each agent with: the goal, the contract files, its owned paths, what not to touch, the gate, and "report honestly".

Worktrees start from the last commit, so commit contracts first if you use `isolation: "worktree"`.

---

## 14. Checklist for a new module or feature

- [ ] Logic lives in `modules/`, not in the kernel or the app
- [ ] Ids, components, systems, actions, events and kinds are namespaced
- [ ] Deterministic: no forbidden APIs, lint is clean, the pinned-hash test passes
- [ ] Invalid input is rejected with `ActionError` and the world is unchanged
- [ ] Other modules are changed with `patch` or `overrides` and declared in `deps`, never edited in place
- [ ] Registered in `catalog.ts`, and the client view in `client/modes/index.ts` if it's a mode
- [ ] Authoritative state lives in the right DO. Cross-owner transfers go through escrow.
- [ ] D1 projection, migration and tests exist if the data must be searchable
- [ ] UI uses slots and logical art ids, and works at 375px and 60 fps on the targets
- [ ] Original names and art only, with licences recorded
- [ ] Gates are green: check, tests, build, e2e. An ADR exists if a real decision was made.

## 15. Classic party conventions (docs/design/party.md)

- `heroOf(world)` is the **controlled** hero. Every other member is a follower driven by the party AI. Iterate members with `partyMembers(world)` (slot order); a world without `RES.party` is a party of one, so solo code paths stay bit-identical.
- Gold and town portal scrolls live on the founder only: read and write them through `purseOf()` / `partyGold()`, never `Wallet` on "the hero".
- Ops take an explicit hero. A `HeroCommand` sets `hero` **only for followers** (owners resolve it with `commandHero()`); events carry `hero` only while a party exists.
- Party size 1 must not touch the RNG or state differently from solo. Prove it with the existing pinned hashes before you bump versions.

## 16. Don'ts

- Don't add game rules to `packages/kernel`, `apps/game/src/server` or `apps/game/src/client`. Put them in modules.
- Don't read D1 to make gameplay decisions, and don't write to D1 except through the sync pipeline.
- Don't use wrangler. Use `cf`.
- Don't commit secrets. `.dev.vars` is git-ignored; use `.dev.vars.example` for defaults.
- Don't bypass `vp`, the formatter or the lint guard.
- Don't push, deploy or create cloud resources unless the user asked for it.
- Don't import a file before it exists. A running `vp dev` remembers an unresolved import of a file outside `apps/game` and keeps serving a 500 for the importer even after the file appears. Create the new file first, then wire it in. Every saved file must compile, because the dev server hot-reloads the tree.
- Don't leave headless browsers running after a QA script. Orphaned QA browsers keep the game running at x8 and slow every later measurement.
