# Classic mode — idle Diablo-like ARPG (phase 2a design)

Status: **phase 2a implemented and integrated** (all eight sim modules, client view, HUD, renderer
extension and art). §21 lists what was actually built, deviations from this design and known gaps.
The mode is not yet wired into `apps/game` (catalog, mode list, server verification): next phase.
Package: `@gamez/mode-classic` in `modules/classic/` (`modules`, `mode`, and `./client` → `classicView`).
Plan references: `~/.claude/plans/we-are-trying-to-parallel-wombat.md` §1, §3, §5, §6, §8, §10. Repo rules: `AGENTS.md`.

The classic mode is a real-time isometric ARPG that **plays itself by default**. A hero explores a big
procedurally generated dungeon, kills monsters with weapon attacks and spells, levels up, picks up
loot, drinks potions, portals to town to sell and restock, and dives deeper. The player can take
control at any moment (click to move/attack, hotkeys) and switch between **Manual**, **Auto** and
**Full Idle** (Auto plus a sim speed multiplier and offline progress).

All names and designs here are original. Generic class names (Warrior, Rogue, Sorcerer) are fine.

---

## 0. Goals and non-goals

Goals (this phase):

1. A complete, deterministic kernel mode (`classic.*` modules) that can be replayed by the server later.
2. A client view that runs that sim **locally** at a fixed 20 Hz with render interpolation, so the
   game is fully playable in the browser now.
3. A Diablo-style HUD (orbs, skill bar, belt, minimap, panels) that works on desktop and at 375 px.
4. A strong base for testing and adding features: data-driven content, a message bus between
   modules, UI slots, a test harness.

Non-goals (later phases): server verification and persistence of classic (CharacterDO), presence
of other players in town, economy hooks (player shops, auction house), parties, crafting.

---

## 1. Package layout and ownership

```
modules/classic/
  package.json  tsconfig.json
  src/
    index.ts           modules[] + mode (id "classic", fixed 20 Hz)           ARCHITECT
    types.ts           registry kinds + prototype types + value types          ARCHITECT (contract)
    components.ts      every component                                         ARCHITECT (contract)
    resources.ts       resource keys/types/getters                             ARCHITECT (contract)
    events.ts          ClassicEvent union + emit()                             ARCHITECT (contract)
    actions.ts         action names + payloads, HeroCommand, ERR, OpResult     ARCHITECT (contract)
    bus.ts             hits/deaths/spawns/transitions/commands queues          ARCHITECT (implemented)
    ids.ts             MODULE ids + SYSTEM table (stage/order)                 ARCHITECT (contract)
    fixed.ts           fixed-point maths, angle tables, facingOf, mix()        ARCHITECT (implemented)
    rules.ts           formulas (xp, hit chance, armor, scaling, values)       ARCHITECT (implemented)
    spatial.ts         per-world spatial grid                                  ARCHITECT (implemented)
    control.ts         noteManual / autoActive                                 ARCHITECT (implemented)
    world/maps.ts      ClassicMap, getAreaMap memo, setTestMap, LOS            ARCHITECT (implemented)
    core/infra.ts      core setup, spatial rebuild, cleanup                    ARCHITECT (implemented)
    content/**         classic.content (data)                                  T1 content
    world/** (not maps.ts)  classic.world                                      T2 world
    core/** (not infra.ts), combat/**  classic.core + classic.combat           T3 core+combat (Opus)
    monsters/**        classic.monsters                                        T4 monsters
    items/**           classic.items                                           T5 items
    progression/**     classic.progression                                     T6 progression
    auto/**            classic.auto (+ score.ts contract signature)            T7 auto/idle (Opus)
    client/contract.ts client contract                                         ARCHITECT (contract)
    client/hud/**      React HUD                                               T9 HUD
    client/*.ts        view, loop, scene, input, persistence                   T10 client view
  tests/
    support/harness.ts  support/content.ts   test harness + test content       ARCHITECT
    contract.test.ts                                                           ARCHITECT
    <area>*.test.ts                                                            each owner
  dev/                 standalone dev harness page (port 5180)                 T10
packages/ui-host/src/render.ts   ArpgWorldRenderer extension types             ARCHITECT (contract)
apps/game/src/client/render/**   Pixi implementation of the extension          T8 renderer
modules/art.kenney/**, apps/game/public/art/kenney/**   art pack               T11 art
```

Contract files are read-only for builders. If a builder finds a contract bug it reports it instead
of editing (or works around it locally and says so).

Wiring classic into `apps/game` (catalog, `client/modes/index.ts`) happens in the next phase.

---

## 2. Determinism and units

All of `modules/classic/src/**` except `src/client/**` and `*.tsx` is sim code (AGENTS.md §6):
no `Math.random`, `Date`, `performance`, timers, I/O, `localeCompare`; iterate `world.query()` /
`registry.all()` or sort explicitly; plain JSON in components/resources/events.

| Quantity                   | Unit                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| Position                   | **sub** units, 256 per tile (`Pos {x, y}` integers). Tile = `x >> 8` |
| Speed                      | sub per tick                                                         |
| Time                       | ticks (20 Hz = 50 ms). Cooldowns/expiry are absolute ticks           |
| Angles                     | integer steps 0..63; `COS64/SIN64` tables (x1024)                    |
| HP, mana, gold, xp, damage | integers                                                             |
| Percentages                | integer percent points (`pct(v, p) = floor(v*p/100)`)                |

Allowed Math for state: `+ - * / %`, `floor ceil round trunc abs min max sign imul sqrt`.
Forbidden for state: `sin cos tan atan2 pow exp log hypot` (not bit-identical across engines).
Use `fixed.ts` helpers: `dist2`, `isqrt`, `scaleTo`, `angleOf`, `angleVec`, `facingOf`, `mix`.

Randomness: `ctx.rng` only, except map generation, which is a **pure function** of
`(registry, worldSeed, depth)` using `createRng(mix(worldSeed, depth))` (so maps never live in the
world and every sim/renderer/server sees the same map).

Every module test file includes a determinism test (same seed + same script → same `hash()`), and
each module pins one hash after a fixed script (update the pin when behaviour changes on purpose).

---

## 3. Architecture

### 3.1 Modules

| Module                | Deps (optional)            | Owns                                                                                      |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `classic.content`     | –                          | all prototypes (data only)                                                                |
| `classic.core`        | (content)                  | GameState, bus, spatial grid, hero Intent executor, movement, input actions               |
| `classic.world`       | core (content)             | areas, town, dungeon levels, population, transitions, exploration, waypoints, portals     |
| `classic.combat`      | core (content)             | skills runtime, casting, projectiles, ground effects, statuses, damage, deaths            |
| `classic.monsters`    | core (content, combat)     | spawning, AI behaviours, champions/uniques/bosses, sleep/wake, corpses, summons           |
| `classic.items`       | core (content)             | item generation, drops, ground loot, inventory, equipment, belt, potions, vendors, stash  |
| `classic.progression` | core (content, items)      | hero creation, stats derivation, XP/levels, regen, death penalty, respawn, quests, points |
| `classic.auto`        | core (everything optional) | Manual/Auto/Idle control, the auto controller, speed, offline progress                    |

Optional deps only fix load order. A module never imports another builder's module files; it talks
through **components**, **resources**, the **bus** and the **registry**. The only cross-module code
imports allowed are the architect files listed in §1 and `auto/score.ts` (signature contract).

### 3.2 The bus (`bus.ts`)

| Queue         | Producers                                     | Consumer                                               | Lifetime                                                                                  |
| ------------- | --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `hits`        | combat, monsters (death bursts)               | `classic.combat.resolveHits` (update 700)              | later pushes carried once by core.cleanup, resolve next tick                              |
| `deaths`      | combat.resolveHits                            | progression, items, world, monsters (post)             | cleared by core.cleanup                                                                   |
| `spawns`      | world (population), combat (summon), monsters | `classic.monsters.spawn` (pre -1050)                   | until drained                                                                             |
| `transitions` | world ops, progression (newHero, respawn)     | `classic.world.transition` (pre -1100)                 | until drained                                                                             |
| `commands`    | auto, core.intent, other systems              | items/world/progression command systems (update 50–52) | leftovers carried one tick (marked `carried: 1`), then dropped + `classic.command.failed` |

### 3.3 Intents, cast orders and commands

- **Hero `Intent`** (`idle | move | skill | pickup | interact`) is the single "what the hero wants"
  slot. Manual actions write it with `source: "manual"`; the auto controller writes it with
  `source: "auto"`. `classic.core.intent` executes it: path, approach, then a `CastOrder` or a command.
- **`CastOrder`** is "cast this when you can" for any unit (hero via intent, monsters via AI).
  `classic.combat.orders` validates (busy, stunned, mana, cooldown, range) and starts `Casting`.
- **`HeroCommand`** (bus) is an instantaneous operation owned by one module (`COMMAND_OWNER`): buy,
  sell, equip, drink, stairs, waypoint, town portal, allocate, learn, respawn, quests, grants. Every
  owner implements `execX(world, ctx, ...) : OpResult` once and uses it from both its action
  (`throw new ActionError(code, message)` when `!ok`) and its command system (emit
  `classic.command.failed` when `!ok`).
- Manual actions in Auto/Idle call `noteManual()` → the controller pauses for 60 ticks (3 s).

### 3.4 Maps are derived, never stored

`ClassicMap extends TileMap` (`world/maps.ts`): ground, objects, walkable, rooms, stairs, waypoint,
NPC spots, portal spot, stash, boss spot. `getAreaMap(world, registry)` memoises
`generateArea(registry, worldSeed, depth)` (LRU of 6). Tests inject maps with `setTestMap`.
Resources stay tiny (snapshots clone them every step): exploration is a bitset (512 numbers for
128×128).

### 3.5 Spatial grid

`gridOf(world)` (WeakMap per World, never in the world): 4-tile cells over the current area,
rebuilt from scratch at `classic.core.spatial` (pre -1000) every tick; movement/spawn/blink/knockback
keep it exact within the tick (`grid.move`, `grid.insert`, `grid.remove`). Queries return sorted ids.

### 3.6 Tick pipeline (THE system table, `ids.ts` `SYSTEM`)

| Stage  | Order | System id                     | Owner       |
| ------ | ----: | ----------------------------- | ----------- |
| pre    | -1100 | classic.world.transition      | world       |
| pre    | -1050 | classic.monsters.spawn        | monsters    |
| pre    | -1000 | classic.core.spatial          | core        |
| pre    |  -900 | classic.items.heroInit        | items       |
| pre    |  -500 | classic.progression.stats     | progression |
| pre    |  -100 | classic.monsters.wake         | monsters    |
| pre    |     0 | classic.auto.think            | auto        |
| pre    |    10 | classic.auto.allocate         | auto        |
| update |    50 | classic.items.commands        | items       |
| update |    51 | classic.world.commands        | world       |
| update |    52 | classic.progression.commands  | progression |
| update |   100 | classic.core.intent           | core        |
| update |   200 | classic.monsters.think        | monsters    |
| update |   250 | classic.combat.orders         | combat      |
| update |   300 | classic.core.movement         | core        |
| update |   350 | classic.combat.dashes         | combat      |
| update |   400 | classic.combat.casting        | combat      |
| update |   500 | classic.combat.projectiles    | combat      |
| update |   550 | classic.combat.effects        | combat      |
| update |   600 | classic.combat.statuses       | combat      |
| update |   700 | classic.combat.resolveHits    | combat      |
| update |   750 | classic.monsters.onDeath      | monsters    |
| post   |     0 | classic.progression.kills     | progression |
| post   |   100 | classic.items.drops           | items       |
| post   |   150 | classic.world.levelState      | world       |
| post   |   200 | classic.monsters.corpses      | monsters    |
| post   |   300 | classic.progression.regen     | progression |
| post   |   500 | classic.world.explore         | world       |
| post   |   600 | classic.progression.heroDeath | progression |
| post   |  1000 | classic.core.cleanup          | core        |

Implement with `{ ...SYSTEM.key, run(world, ctx) { … } }`. Every system early-outs cheaply when it
has nothing to do (no hero, no queue entries). Only entities whose `AreaTag.depth` equals the current
area are simulated.

### 3.7 Actions

See `actions.ts` (`ACTION`, `ActionPayloads`, `ERR`). Owners: progression (newHero, allocateStat,
learnSkill, setSkillBar, respawn, acceptQuest, completeQuest), core (moveTo, useSkill, stop, pickup,
interact), items (equip, unequip, moveItem, dropItem, drinkPotion, buy, sell, stashPut, stashTake),
world (townPortal, usePortal, useStairs, useWaypoint), auto (setControl, setSpeed, setAutoConfig,
offlineProgress). All actions throw `ActionError(ERR.noHero)` without a hero and
`ERR.dead` while the hero is dead (except respawn/setControl/setSpeed/setAutoConfig).

---

## 4. Entities and components

See `components.ts` for exact shapes and owners. Summary:

| Entity        | Components                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hero          | Hero, Level, Attributes, SkillBook, SkillBar, Life, Mana, CombatStats, HeroStats, Pos, AreaTag, Mover, Body, Faction, Intent, Statuses, Inventory, Equipment, Belt, Wallet, Supplies, AutoState (+ Casting, CastOrder, Dash, Dead) |
| monster       | Monster, Ai, SkillBook, Life, CombatStats, Pos, AreaTag, Mover, Body, Faction, Statuses (+ Casting, CastOrder, Dash, Dead, Summoned)                                                                                               |
| projectile    | Projectile, Pos, AreaTag                                                                                                                                                                                                           |
| ground effect | GroundEffect, Pos, AreaTag                                                                                                                                                                                                         |
| loot          | Loot, Pos, AreaTag                                                                                                                                                                                                                 |
| npc           | Npc, Pos, AreaTag(0), Body                                                                                                                                                                                                         |
| interactable  | Interactable (stairsDown/stairsUp/waypoint/portal/stash), Pos, AreaTag                                                                                                                                                             |

Hero creation (`classic.newHero`, progression) is component-driven: progression adds the identity,
level, attributes, skills, vitals, stats placeholders, Mover/Body/Faction/Intent/Statuses and pushes
transition `{to: 0, via: "new"}`; next tick world places the hero (Pos + AreaTag), items adds the
bag/equipment/belt/wallet/supplies with the starter kit, progression computes stats.

---

## 5. Core: movement and the intent executor (T3)

**Movement** (`classic.core.movement`, update 300) for every `Mover` in the current area, skipping
sleeping monsters, Dead, Dash, stunned units and units with `Casting` (except `pulse` skills):

1. Effective speed = `Mover.speed × CombatStats.moveSpeed% × (100 − slow)%` (slow = strongest
   `slow` status power), minimum 1 if > 0.
2. If `path` is non-empty, steer toward the centre of `path[0]`; pop when within `speed`. Else if
   `goalX ≥ 0`, steer straight toward the goal; clear it when reached.
3. Wall collision: try the full step; if any of the body's 4 corner points (± radius×0.7) lands on a
   blocked tile, try X only, then Y only (sliding); else stay and `blocked++`.
4. Soft separation: for solid units, push away from overlapping solid neighbours (grid query of
   radius×2) by at most `speed/2`, never into walls. Heroes are not pushed by monsters' separation
   more than 1/4 of that.
5. Set `moving`, `facing = facingOf(dx, dy)` in tile space, `blocked` (reset on progress), and call
   `grid.move`.

**Intent executor** (`classic.core.intent`, update 100), hero only, skips while busy (Casting, Dash,
Dead, stun):

- `move`: A* (`findPath` from `@gamez/world`, maxNodes 6000) from the hero tile to the target tile;
  store in `Mover.path`; on failure try the nearest walkable tile within 3 tiles; done when arrived →
  `idle`.
- `skill`: resolve range (`SkillProto.range`, or `CombatStats.attackRange` when the skill's range is
  0); self skills cast immediately; if the target entity is gone/Dead → `idle`. Out of range or no
  line of sight → path toward the target (re-path at most every 10 ticks or when the target moved
  more than 2 tiles from the last path goal). In range → clear path, add `CastOrder`; with
  `repeat`, keep re-issuing after each cast until the target dies; otherwise → `idle` once the cast
  started.
- `pickup`: walk until within `APPROACH_RANGE`, then `pushCommand({op:"pickup", target})` → `idle`.
- `interact`: walk until within `APPROACH_RANGE`, then:
  NPC → emit `classic.npc.opened` (+ healer: `{op:"heal", npc}`);
  Interactable stairs → `{op:"stairs", target}`; portal → `{op:"usePortal"}`;
  waypoint → emit `classic.waypoint.opened` (manual) — the auto controller uses `{op:"waypoint"}`
  directly when near; stash → emit `classic.stash.opened`. Then `idle`.

**Input actions** (core): `classic.moveTo {x,y}` (tile, in bounds, walkable), `classic.useSkill`
(skill known with rank ≥ 1, target 0 or a live unit in the current area, x/y within the map),
`classic.stop` (idle, clear path), `classic.pickup {target}` (Loot in area), `classic.interact
{target}` (Npc/Interactable in area). They write `Intent` (source "manual") and call `noteManual`.

---

## 6. Classes, attributes and progression (T1 data, T6 runtime)

### 6.1 Classes

| Class (id)                  | Str | Dex | Mag | Vit | Life base/perVit/perLevel | Mana base/perMag/perLevel | Primary | autoAlloc (s/d/m/v) | Starter gear                      | Starter potions            |
| --------------------------- | --: | --: | --: | --: | ------------------------- | ------------------------- | ------- | ------------------- | --------------------------------- | -------------------------- |
| Warrior `classic.warrior`   |  30 |  20 |  10 |  25 | 50 / 3 / 3                | 10 / 1 / 2                | str     | 2/1/0/2             | short sword, buckler, leather cap | 4 minor life               |
| Rogue `classic.rogue`       |  20 |  30 |  15 |  20 | 48 / 2 / 3                | 20 / 2 / 2                | dex     | 1/3/0/1             | hunting bow, padded vest          | 3 minor life, 1 minor mana |
| Sorcerer `classic.sorcerer` |  15 |  20 |  35 |  15 | 30 / 2 / 1                | 25 / 2 / 2                | mag     | 0/1/3/1             | gnarled staff (2H)                | 2 minor life, 2 minor mana |

All move at 51 sub/tick (4 tiles/s). Appearance `unit.hero.<class>` falls back to `unit.hero` tinted.

### 6.2 Derived stats (progression `classic.progression.stats`, every tick, hero only)

`T` = `addItemStats(registry, equipped items)` plus buff status mods (`StatusProto.mods × power`).

- Attributes: `attr = Attributes.attr + T[attr] + T.allAttrs`.
- `lifeMax = (life.base + vit×perVit + (level−1)×perLevel + T.life) × (100 + T.lifePct)%`.
- `manaMax = (mana.base + mag×perMag + (level−1)×perLevel + T.mana) × (100 + T.manaPct)%`.
- `armor = (floor(dex/4) + Σ base.armor + T.armor) × (100 + T.armorPct)%`.
- `toHit = (dex×5 + level×10 + T.toHit) × (100 + T.toHitPct)%`.
- Weapon: `dmgMin/Max = (weapon base or fists 1–3) + T.dmgMin/T.dmgMax`, then
  `× (100 + primaryAttr + T.dmgPct)%`. `addFire/addCold/addLightning/addPoison = T.*Dmg`.
- `spellPct = T.spellPct`; `critPct = 5 + floor(dex/10) + T.critPct`; `critMult = 150 + T.critDmgPct`.
- `attackSpeed = 100 + T.attackSpeed`; `castSpeed = 100 + T.castSpeed`; `moveSpeed = 100 + T.moveSpeed`.
- Resists: `T.resX + T.resAll` (capped at 75 by `rules.resistOf`).
- `blockPct = shield.block + T.blockPct` (0 without a shield); `lifeSteal`, `manaSteal`, `thorns`.
- Basic attack: `attackTicks = weapon.attackTicks ?? 12`, `attackRange = weapon.range ?? 400`,
  `attackProjectile = weapon.projectile ?? ""`, `attackElement = "phys"`.
- Sheet: `lifeRegen (×10/s) = 5 + floor(vit/5) + T.lifeRegen`;
  `manaRegen (×10/s) = floor(manaMax×10/40) × (100 + T.manaRegenPct)%` (full bar in ~40 s);
  `lightRadius = balance.lightRadius + T.lightRadius`; `magicFind`, `goldFind`, `lifeOnKill`,
  `manaOnKill`, `allSkills`, `potionPct`, `twoHanded`, `primary`.
- Clamp `Life.hp ≤ max`, `Mana.mp ≤ max` (raising max does not heal).

### 6.3 XP and levels

`xpToNext(L) = 30·L² + 40·L` (L1 → 70, L10 → 3 400, L30 → 28 200; tuned in integration so every
class reaches level 5 within 20 minutes of Auto); max level 60.
Monster level per depth: `1 + floor(3·(depth−1)/2)` (1, 2, 4, 5, 7, 8 …).
XP per kill = `Monster.xp` (already scaled) with the level-difference penalty
(`rules.xpForKill`: beyond 5 levels above the monster, −15 % per level, min 5 %).
Level up: +5 stat points, +1 skill point, full life and mana, `classic.levelUp`. Several levels at
once are handled in a loop. In Auto/Idle (`config.autoAllocate`) the controller spends stat points by
`ClassProto.autoAlloc` and skill points by `autoSkillOrder` (first learnable entry, cycling, skipping
maxed or level-locked skills); in Manual the player uses the character/skills panels.

### 6.4 Death and respawn

On hero death (`Dead` added by combat): once, lose `deathGoldLossPct` (10 %) of carried gold and
`deathXpLossPct` (5 %) of the XP earned inside the current level (never below the level start); emit
`classic.hero.died`; cancel casts/intent. After `respawnDelay` (60 ticks) `classic.respawn` / op
`respawn` removes `Dead`, restores full life/mana and pushes transition `{to: 0, via: "respawn"}`
(the live dungeon level stays; the town waypoint or a portal brings the hero back). Items are kept.

---

## 7. Skills (T1 data, T3 runtime)

### 7.1 Hero skills (15)

Ranges in tiles (×256 in data), durations in ticks. `w%` = weapon damage %, `+r` = per rank above 1.

| Id (`classic.skill.*`) | Name           | Class    | Lvl | Shape                                                              | Target | Mana  |  CD | Cast/hit            | Effect                                                                                         |
| ---------------------- | -------------- | -------- | --: | ------------------------------------------------------------------ | ------ | ----- | --: | ------------------- | ---------------------------------------------------------------------------------------------- |
| `attack`               | Attack         | all      |   1 | melee (range 0 = weapon reach; ranged weapon fires its projectile) | enemy  | 0     |   0 | weapon ticks / half | 100 w%, canMiss                                                                                |
| `mend`                 | Mend           | all      |   6 | self                                                               | self   | 12 +1 | 200 | 10/5                | heal 20 % +2 %/r of max + 10                                                                   |
| `cleave`               | Cleave         | Warrior  |   1 | arc (±10 steps), range 1.8                                         | enemy  | 4     |   0 | 14/7                | 130 w% +8/r to all in the arc                                                                  |
| `whirl`                | Whirling Steel | Warrior  |   6 | pulse r 1.8, 6 pulses every 4                                      | self   | 14 +1 |  60 | 24/4                | 70 w% +5/r per pulse; caster may move                                                          |
| `rally`                | Rallying Cry   | Warrior  |   3 | self, radius 4                                                     | self   | 10    | 300 | 10/5                | buff `rally` (+20 % +3/r dmg & armor, 200 ticks) on hero team; stun enemies in radius 20 ticks |
| `charge`               | Shield Rush    | Warrior  |   9 | dash speed 160, max 8                                              | enemy  | 8     |  80 | 6/6                 | 150 w% +10/r on arrival, stun 30, knockback 1 tile                                             |
| `multishot`            | Fan of Arrows  | Rogue    |   1 | projectile ×5, spread 3, speed 80, range 10                        | point  | 4     |   0 | 14/8                | 85 w% +5/r each                                                                                |
| `venom_shot`           | Venom Shot     | Rogue    |   3 | projectile, speed 80, range 10                                     | enemy  | 5     |   0 | 12/6                | 110 w% +6/r + `poison` dot 16 +8/r over 60 ticks                                               |
| `spark_sentry`         | Spark Sentry   | Rogue    |   6 | summon `classic.monster.sentry` ×1, max 2, 300 ticks, range 6      | point  | 15    | 100 | 10/5                | sentry fires `sentry_bolt` (lightning) at enemies                                              |
| `tumble`               | Shadow Tumble  | Rogue    |   9 | dash speed 140, max 6                                              | point  | 6     |  60 | 4/4                 | mobility (no damage)                                                                           |
| `ember_bolt`           | Ember Bolt     | Sorcerer |   1 | projectile speed 70, range 10                                      | point  | 3     |   0 | 12/6 cast           | fire 4–8 +2/+3, scaling mag                                                                    |
| `frost_ring`           | Frost Ring     | Sorcerer |   3 | nova r 3.5                                                         | self   | 10 +1 |  60 | 14/6                | cold 3–6 +2/+2, `chill` 40 % slow 60 ticks                                                     |
| `arc_chain`            | Arc Chain      | Sorcerer |   6 | chain 4 bounces, 4 tiles, −15 %/bounce, range 9                    | enemy  | 8 +1  |   0 | 14/7                | lightning 2–14 +1/+4                                                                           |
| `cinder_orb`           | Cinder Orb     | Sorcerer |   9 | projectile speed 56, homes on its target, explodes r 2, range 10   | point  | 14 +1 |  30 | 16/8                | fire 10–18 +4/+6, 50 % `burn` 8 +4/r over 60                                                   |
| `phase_step`           | Phase Step     | Sorcerer |  12 | blink ≤ 8 tiles to a walkable tile                                 | point  | 10    |  80 | 8/4                 | mobility                                                                                       |

Starting skills: Warrior attack + cleave; Rogue attack + multishot; Sorcerer attack + ember_bolt.
Default bars: `[attack, cleave|multishot|ember_bolt, null…]`; learned skills auto-fill empty slots in
Auto/Idle. Max rank 20. AI hints (`ai.tags`, `priority`, `minTargets`) drive the auto controller.

### 7.2 Monster skills (`classic.mskill.*`, users "monster")

All monster skills use `weaponPct` (they scale with the monster's level-scaled damage and use its
`attackElement`): `claw` (melee 100), `bite` (melee 80, fast 8 ticks), `gore` (melee 120),
`arrow` (projectile 100, speed 70, range 9), `firebolt` (projectile 110, speed 60, cast), `frostbolt`
(projectile 100 + `chill` 30 %), `shadebolt` (projectile 90), `slam` (nova r 1.6, 130, 15 % stun),
`charge` (dash 120, max 7, 150 + stun 20), `raise` (summon `classic.monster.husk` ×2, max 6, cd 160),
`burst` (aoeTarget at self r 2, 250, poison; exploders), `ember_burst` (nova r 2 fire 120, mod
death skill), `sentry_bolt` (projectile lightning 100, speed 90, range 8), boss skills `boss_slam`
(nova r 3, 160, stun 16, cooldown 120), `boss_nova` (nova r 4, 120, fire, cooldown 80), `boss_volley` (projectile ×7 spread 4,
90, cooldown 60), `boss_summon` (summon the boss's minion type ×3, max 9, cd 200).

### 7.3 Runtime semantics (combat, data-driven, heroes and monsters alike)

- **Orders** (`classic.combat.orders`): unit not busy (Casting/Dash/Dead/stun); skill known; off
  cooldown; mana ≥ `skillManaCost` (monsters have no Mana → free); target valid and within range
  (+ target body radius) — else emit `classic.cast.failed` and drop the order. Start `Casting` with
  `castTicks`/`hitTick` scaled by `scaledTicks(…, attackSpeed or castSpeed)` minus slow; spend mana;
  set cooldown `readyAt = tick + cooldown`; face the target; emit `classic.cast`.
  Basic attack (`range 0`): ticks = `CombatStats.attackTicks`, reach = `attackRange`.
- **Casting** (`classic.combat.casting`): at `hitAt` fire once; free at `endAt`. Fire by shape:
  melee (one hit on the target if still within reach + 0.5 tile), arc (every enemy within range and
  `angleDiff ≤ arc` of the facing angle), projectile (count, symmetric spread around the aim angle,
  `Projectile` entities; ranged basic attacks use `attackProjectile`), nova (all enemies in radius
  around caster), aoeTarget (radius around target point), chain (target, then nearest un-hit enemy
  within range, `bounces` times, damage −falloff % each; emit one `classic.effect` with the polyline),
  dash (add `Dash`), blink (move to the nearest walkable tile ≤ maxRange toward the point; grid.move;
  `classic.effect` blink), summon (push `SpawnRequest`s with owner/team/until, respecting `max` alive
  per owner), self (heal; buff on caster and hero-team allies in `radius`; `status` to enemies in
  `radius`), pulse (one nova every `pulse.every` ticks, `pulse.count` times).
- Arc swings emit one `classic.effect` per fired cast, hit or miss: centred on the caster, `radius`
  = reach, `points` = `[aim tip]` (caster + reach along the aim) so the client orients the slash
  (`EffectSpec.x2/y2`). The client skips the cast-time visual of arc skills by a live caster (no
  double slash) and orients every slash cast toward its target point.
- Damage per hit = `rollSkillDamage(skill, effectiveRank, casterStats, heroAttrs|null, ctx.rng)`;
  crit rolled by the caster (`critPct`); pushed as `HitRequest` with the skill's `status`.
- **Projectiles**: move `vx, vy` per tick (aim from `angleOf`/`angleVec`), collide with enemy bodies
  via the grid (`radius + body.radius`), skip already-hit, pierce, stop on walls; on impact or at
  max range with `explodeRadius` → area hit + `classic.effect`.
- **Ground effects** tick every `every` ticks while alive (used by bursts/fields; optional).
- **Statuses**: `slow` (power % slower move and attack/cast), `stun` (no orders, no movement, casts
  interrupted), `dot` (`power` total damage split over the duration, ticks every `every`,
  `HitRequest` with `dot: true`), `buff` (stat mods, read by progression.stats and monster damage).
  Re-applying keeps the longer `until` and the higher `power`.

---

## 8. Monsters (T1 data, T4 runtime)

### 8.1 Roster (at monster level 1; scaled by `rules.scaleMonster`)

| Id (`classic.monster.*`) | Name                       | Behaviour         | Life | Armor | ToHit | Dmg  | Elem      |  XP | Speed | Skills             | Pack | Themes              | Min depth |
| ------------------------ | -------------------------- | ----------------- | ---: | ----: | ----: | ---- | --------- | --: | ----: | ------------------ | ---- | ------------------- | --------: |
| `husk`                   | Shambling Husk             | rusher            |   18 |     6 |    25 | 2–5  | phys      |   9 |    30 | claw               | 3–6  | crypt, caves        |         1 |
| `gnawling`               | Gnawling                   | swarm             |    7 |     2 |    30 | 1–3  | phys      |   4 |    62 | bite               | 6–10 | crypt, caves        |         1 |
| `bonefletcher`           | Bonefletcher               | archer (keep 5)   |   12 |     4 |    30 | 2–4  | phys      |  10 |    40 | arrow              | 2–4  | crypt, forge        |         1 |
| `ash_seer`               | Ash Seer                   | caster (keep 6)   |   14 |     3 |    25 | 3–6  | fire      |  14 |    36 | firebolt           | 2–3  | crypt, forge        |         2 |
| `blightbloat`            | Blightbloat                | exploder          |   16 |     0 |    40 | 6–12 | poison    |  12 |    44 | burst (+ on death) | 2–4  | caves, abyss        |         2 |
| `bristleback`            | Bristleback                | charger           |   30 |    10 |    35 | 4–8  | phys      |  20 |    48 | gore, charge       | 2–4  | caves               |         2 |
| `cairn_brute`            | Cairn Brute                | tank              |   60 |    18 |    30 | 5–10 | phys      |  30 |    26 | claw, slam         | 1–2  | caves, forge, abyss |         3 |
| `webskitter`             | Webskitter                 | swarm             |    9 |     3 |    35 | 2–4  | poison    |   6 |    60 | bite               | 5–8  | caves, abyss        |         3 |
| `hollow_cantor`          | Hollow Cantor              | summoner (keep 6) |   20 |     4 |    20 | 2–4  | cold      |  25 |    34 | shadebolt, raise   | 1–2  | crypt, abyss        |   2 (§21) |
| `cinder_imp`             | Cinder Imp                 | rusher (fast)     |   12 |     5 |    35 | 3–5  | fire      |  10 |    58 | claw               | 4–7  | forge               |         5 |
| `rime_wraith`            | Rime Wraith                | caster (keep 5)   |   18 |     6 |    35 | 3–7  | cold      |  18 |    44 | frostbolt          | 2–3  | abyss, forge        |         6 |
| `sentry`                 | Spark Sentry (hero summon) | totem             |   30 |    10 |    50 | 3–8  | lightning |   0 |     0 | sentry_bolt        | –    | –                   |         – |

Bosses (`boss` set, `themes: []`, one per 4th depth, cycling with level scaling after 16):

| Id                   | Name                     | Depth | Life | Dmg   |   XP | Skills                              | Minions        |
| -------------------- | ------------------------ | ----: | ---: | ----- | ---: | ----------------------------------- | -------------- |
| `boss_warden`        | Morrow, the Grave Warden |     4 |  600 | 8–14  |  400 | claw, boss_slam, raise              | husk ×4        |
| `boss_tunnel_mother` | Skarn, the Tunnel Mother |     8 | 1100 | 10–18 |  900 | gore, charge, boss_summon           | gnawling ×8    |
| `boss_ninth_flame`   | Vessa of the Ninth Flame |    12 | 1500 | 12–20 | 1600 | firebolt, boss_volley, boss_nova    | ash_seer ×3    |
| `boss_hollow_king`   | The Hollow King          |    16 | 2400 | 15–26 | 3000 | claw, boss_slam, boss_volley, raise | rime_wraith ×3 |

### 8.2 Behaviours (`classic.monsters.think`)

Common: awake monsters pick the nearest hero-team unit within `aggroRange` (prefer the hero, keep
the current target unless it is 50 % farther than another); out of range and not hit for 100 ticks →
`return` home. Chasing uses a **hero distance field** (BFS on tiles from the hero's tile, radius 24,
memoised per (map id, hero tile) outside the world — pure, so safe) so monsters walk around walls
without per-monster A*; when the field does not cover them, direct steering + A* at most once per
40 ticks per monster and at most 4 A* searches per tick overall. Think throttle: every 4 ticks per
monster (staggered by id), every tick when in attack range.

| Behaviour | Rule                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rusher    | chase; basic attack in reach                                                                                                                                                                                                               |
| swarm     | like rusher, offsets its approach angle by `(id % 8) × 8` steps so the pack surrounds                                                                                                                                                      |
| archer    | keep `keepDistance`: if closer than 60 % of it, step away (kite); in range + LOS → arrow                                                                                                                                                   |
| caster    | like archer; flees to its home when the target is adjacent                                                                                                                                                                                 |
| tank      | slow chase; `slam` when ≥ 2 hero-team units are within 1.6 tiles or every 4th attack (`Ai.count`)                                                                                                                                          |
| charger   | between 3 and 7 tiles with LOS and `specialAt` ready → `charge` (cooldown 100), else rusher                                                                                                                                                |
| summoner  | keep distance 6; `raise` when < max minions alive, `specialAt` ready and its target within 9 tiles in LOS; else shadebolt                                                                                                                  |
| exploder  | rush; within 1.2 tiles → `burst` (16-tick telegraph); detonating kills itself (no double burst)                                                                                                                                            |
| boss      | summons once per threshold crossed (66 % and 33 % life, `Ai.count` = phases done) before anything else; otherwise rotates its skills by priority and cooldown (every boss attack skill has one: Tremor 120, Pyre Nova 80, Volley 60 ticks) |
| totem     | never moves; fires its first skill at the nearest enemy in range                                                                                                                                                                           |

Champion/unique **mods** (`classic.mod.*`): `mighty` (+100 % dmg), `swift` (+50 % speed and attack
speed), `stoneskin` (+100 % armor, +50 % life), `emberbound` (+50 % as fire, death `ember_burst`,
+40 fire resist), `rimebound` (+40 % as cold, chill on hit), `stormbound` (+50 % as lightning, +40
lightning resist), `blinking` (blink next to its target every 100 ticks), `leeching` (20 % life
steal), `volley` (+2 projectiles, ranged only, depth ≥ 3).

### 8.3 Packs, rarity and population

- Pack sizes from `packSize`. 15 % of packs are **champion packs** (all members champion with the
  same 1 mod, 2 mods from depth 9). 1–2 **unique packs** per level (both ramp in over the first
  depths, `packRampDepth` 3: depth 1 has 5 % champions and no unique pack, depth 2 10 % and 0–1): a unique leader (2 mods, 3 from
  depth 9, name from `classic.names.uniqueMonster`: "Grim Fang") with 3–6 minions of its type.
- Rarity scaling (`RARITY_SCALE`): champion ×3 life ×1.5 dmg ×3 xp; unique ×4 life ×1.75 dmg ×5 xp;
  minion ×1.5 life. Monster level = `monsterLevel(depth)` (+1 champion, +2 unique, +3 boss).
- `classic.world` places packs (pushSpawn) on level creation: `rng(packs) + depth/2` packs (capped
  so the level holds ≤ `maxMonstersPerLevel` ≈ 300), one per random non-arrival room tile cluster,
  never within 12 tiles of the arrival point; boss + minions at `bossSpot` on boss depths.
- **Sleep/wake** (`classic.monsters.wake`): every 10 ticks per monster (staggered `(e + tick) % 10`):
  farther than `sleepRange` (20 tiles) → `sleep` (no AI, no movement); nearer → `idle`; a hit wakes
  the target and its pack immediately (combat sets `Ai.state = "chase"` on hit).
- Corpses removed `corpseTicks` (40) after death; summons expire at `until` or when the owner dies
  or leaves the area.

---

## 9. World (T2)

### 9.1 Town (depth 0, ~72×72)

Hand-shaped but seeded layout (`createRng(mix(worldSeed, 0))` for decoration only): grass with a
stone plaza in the centre, dirt paths, a tree border (blocked), houses (`prop.house*`, blocked 3×3
footprints), fences, a well. NPC spots around the plaza:

| NPC (`classic.npc.*`)            | Role      | Notes                                                                                                                                                                |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maren` — Sister Maren, Healer   | healer    | free full heal on interact                                                                                                                                           |
| `brannoc` — Brannoc, Smith       | smith     | sells 12 items (40 % normal, 45 % magic, 15 % rare; weapons, armor and jewelry) at item value (restocked each return from the dungeon, ilvl = deepest monster level) |
| `ysolde` — Ysolde, Alchemist     | alchemist | sells life/mana/rejuvenation potions (a tier unlocks at hero level ≥ its item level − 2) and town portal scrolls                                                     |
| `old_pell` — Old Pell, Rag Buyer | junk      | buys any item for **10 %** of its value (the only buyer: a lowball sink)                                                                                             |
| `captain_hale` — Captain Hale    | quest     | gives and rewards quests                                                                                                                                             |

Plus the town **waypoint** (centre), **stash** chest, **portal spot**, and the dungeon entrance
(`stairsDown` Interactable to depth 1) at the east edge. Town is fully explored.

### 9.2 Dungeon levels (depth ≥ 1, 128×128)

Generator (pure, `createRng(mix(worldSeed, depth))`):

1. All rock. Place 18–26 rectangular rooms (sizes 6–16) by rejection sampling with a 2-tile gap.
2. Connect rooms with a minimum spanning tree over room centres (Manhattan distance, ties by index)
   plus ~15 % extra edges for loops; carve L-shaped corridors 2 tiles wide (3 in caves).
3. Doors (`prop.door`, walkable object) where a corridor enters a room.
4. Theme by tier (`tierOf(depth)`): 0 Crypt, 1 Caves (rough edges: one cellular-automata smoothing
   pass on corridors), 2 Hollow Forge, 3 Abyss; floor variants by a cheap hash of (x, y).
5. Walls: rock tiles 8-adjacent to floor get the theme wall object; other rock gets ground
   `tile.void` and no object (keeps sprite counts low).
6. Decor: blocking props on room perimeter tiles only (never within 2 tiles of a door/stairs).
7. `stairsUp` in `rooms[0]` (arrival; `spawn` next to it), `stairsDown` in the room with the largest
   BFS distance from the spawn; boss depths put `bossSpot` there too. Waypoint in `rooms[0]` when
   `isWaypointDepth(depth)` (every odd depth: 1, 3, 5, ...).
8. Validate: every room reachable from spawn (BFS); otherwise carve a direct corridor.

### 9.3 Transitions (`classic.world.transition`) and travel ops

| Via           | From → to                       | Arrival                                            |
| ------------- | ------------------------------- | -------------------------------------------------- |
| new / respawn | → town                          | town spawn                                         |
| stairsDown    | town → 1, d → d+1               | next to `stairsUp` of the new level                |
| stairsUp      | d → d−1 (0 = town)              | next to `stairsDown` there                         |
| waypoint      | any waypoint → unlocked depth w | next to that map's waypoint                        |
| townPortal    | dungeon d → town                | town `portalSpot`; opens a portal pair (scroll −1) |
| portal        | town ↔ portal depth             | at the portal; using it from town closes the pair  |

Entering a depth equal to `DungeonState.live` reuses its entities (town round trips keep monsters,
loot and exploration). Entering a different depth destroys the old level's entities (monsters, loot,
projectiles, effects, interactables, hero summons), resets its exploration, generates population and
Interactables (stairs, waypoint), updates `deepest` and unlocks waypoints on arrival. Leaving any
area destroys hero summons and in-flight projectiles of that area.

Exploration: `classic.world.explore` reveals all tiles within `lightRadius` (circle) whenever the
hero's tile changes; `revealed/total` counts walkable tiles. `classic.level.cleared` fires once when
the live level reaches 100 % kills.

---

## 10. Damage resolution (T3, `classic.combat.resolveHits`)

For each `HitRequest` (in queue order) whose target is alive in the current area:

1. If `canMiss`: roll `hitChance(src.toHit, src.level, def.armor, def.level)`; miss → `classic.miss`.
   Hero with a shield: roll `blockPct` (max 75) → blocked miss.
2. `d = mitigate(damage, defenderStats, attackerLevel)`; crit → ×`critMult`%; total ≥ 1.
3. Apply to `Life.hp`; lifesteal/manasteal to the source (not for dots); thorns back to melee
   attackers; statuses (`chancePct` rolls); knockback (push along the source→target direction,
   stopping at walls); wake sleeping targets; emit `classic.hit` (dominant element for colour).
4. hp ≤ 0 → `Dead {at, killer}`, remove from grid, cancel Casting/Dash/CastOrder, push `DeathRecord`
   (credit team = hero when the killer is the hero or a hero summon), emit `classic.death`.

Monster attacks against the hero follow the same path (the hero's armor, resists and block apply).

---

## 11. Loot and items (T1 data, T5 runtime)

### 11.1 Bases (`classic.item.*`)

Weapons (1H unless noted; ticks at 100 % speed; range in tiles):
short sword 2–7 (12, 1.6), broadsword 4–11 (13), war axe 5–13 (14), mace 4–10 (13), dagger 1–6 (9),
hunting bow 4–8 2H (11, ranged 10, `fx.arrow`), long bow 3–10 2H (14, ranged 11), gnarled staff 2–8 2H
(14, implicit +10 mana), runed staff 4–12 2H (14, +15 mana, +10 % spell), ash wand 1–4 (11, ranged 8,
`fx.spark`, +8 % spell).
Armor: padded vest 6, leather armor 10, chain mail 18, plate 28. Helms: leather cap 3, iron helm 6,
great helm 10. Shields: buckler 4 (block 15), kite shield 8 (block 20), tower shield 12 (block 25).
Gloves 2–5, boots 2–5, belts are not items (the belt is fixed). Rings, amulets (no base stats).
Potions: life minor/light/greater/super (50/120/260/500), mana minor/light/greater (30/70/150),
rejuvenation (35 % of both). Item level gates bases (`ilvl`), so deeper levels drop better bases.
Sizes: rings/amulets/potions 1×1, daggers/wands 1×2, swords/axes/maces 1×3, bows/staves 2×3,
armor 2×3, helms/gloves/boots 2×2, shields 2×2–2×3.

### 11.2 Rarity and affixes

- Drop rarity weights normal 600 / magic 300 / rare 90 / unique 10; magic find multiplies the
  magic weight by `(100 + mf)%`, rare by `(100 + mf×0.6)%`, unique by `(100 + mf×0.4)%`.
- Magic: 1 prefix and/or 1 suffix ("Fiery Short Sword of the Bear"). Rare: 3–5 affixes, ≤ 3 of each
  kind, unique groups, name from `classic.names.rareItem` ("Grim Shade"). Unique: a `UniqueProto`
  whose base and ilvl fit, with rolled mods; falls back to rare when none fits.
- Affix tiers: each `AffixProto` is one tier (`ilvl` gate); roll uniformly between min and max.
  At least 40 affix tiers covering life, mana, attributes, armor, damage %, flat elemental damage,
  attack/cast speed, crit, resists, life/mana steal, regen, magic/gold find, move speed, +all skills
  (amulets only, high ilvl), block, thorns, light radius, potion %. At least 12 uniques.
- Item value: `rules.itemValue`. Vendors sell at value; the junk buyer pays 10 %.

### 11.3 Drops (`classic.items.drops`, from `Bus.deaths` with `creditTeam === "hero"`)

Per monster rarity (`BalanceProto.drops`): normal item 12 %, gold 45 %, potion 12 %; champion 40 %
item (1–2), unique 100 % (2–3), boss 100 % (4–6, at least two rare+). Gold =
`rng(goldPerLevel) × monsterLevel × (100 + goldFind)%`. Potion tier by depth. Item level = monster
level. Loot is spread on walkable tiles around the death point; each drop emits
`classic.loot.dropped`.

### 11.4 Inventory, equipment, belt, stash, vendors

- Inventory grid 10×4 with item footprints; first-fit placement scanning rows then columns;
  `moveItem` validates the target rectangle. "Bag full" = no space for the item → `classic.bag.full`.
- Equipment slots: weapon, offhand (shield; empty with a 2H weapon), helm, armor, gloves, boots,
  amulet, ring1, ring2. Equip checks `reqLevel/reqStr/reqDex`; the replaced item goes back to the
  bag (fail when it does not fit).
- Belt: 4 slots, each one potion base stacked to 5; potions picked up stack into a matching slot,
  then an empty slot; drinking has a 20-tick shared cooldown; `potionPct` boosts the effect.
- Pickup: gold → wallet (+`classic.gold`); potion → belt (fail if full); item → bag.
- Stash: 50 items (town only, near the stash). Town portal scrolls in `Supplies` (max 10).
- Vendors: stock rolled with `ctx.rng` when the hero enters town after being in the dungeon.
  Alchemist potion prices = base value; scroll = `tpScrollPrice` (50).

---

## 12. Client (T10 view, T8 renderer)

### 12.1 View (`classicView.mount(host, services)`)

1. Layers: world (Pixi) and HUD (React, `pointer-events: none` except widgets).
2. `renderer = services.createWorldRenderer()`; require `isArpgRenderer(renderer)` (otherwise show
   an error). `await renderer.init(layer, services.manifest, services.assetBaseUrl)`.
3. `loaded = loadMode(mode, modules)`; restore the local save (`persist.ts`, localStorage key
   `gamez.classic.save.v1`, wrapped in try/catch) when its `contentHash` matches, else
   `createSim(loaded, { seed: random })`. If the save is older than 60 s and the control mode is not
   manual → dispatch `classic.offlineProgress {elapsedMs}` and show the summary toast.
4. `game.ts` builds the `ClassicClientApi` (stores, act, panels, settings, minimap, castSlot,
   drink, newGame, exit) and owns the loop, the scene sync and the event fan-out.
5. Mount `<ClassicHud api slots>` with `registerDefaultHud(slots)` on a fresh `createSlotRegistry()`.
6. Save every 10 s, on `pagehide`/`visibilitychange` hidden, and on unmount. Unmount destroys
   everything (renderer, React root, listeners, loop).

### 12.2 Fixed loop and interpolation (`loop.ts`)

Driven by `renderer.onFrame(dtMs)`: `acc += min(dt, 250) × speed`; `k = floor(acc / 50)` capped at
`8 × speed` per frame (drop the rest); when `k > 0`: capture previous positions of rendered
entities, `events = sim.step(k)` (one call → one kernel snapshot), `acc −= k × 50`. Render alpha =
`acc / 50` (≤ 1); interpolated position = `prev + (cur − prev) × alpha` (no interpolation for
entities that teleported more than 3 tiles). Measure sim ms per tick for the perf overlay.

### 12.3 Scene sync (`scene.ts`)

Current-area entities → `ArpgRenderEntity` ids `c<entity>`; only upsert changed or moving ones;
remove missing ones.

| Entity     | appearance / fields                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hero       | `ClassProto.appearance`, `fallbackAppearance "unit.hero"`, tint, `isSelf`, action from Casting (attack/cast)/Dead/moving                                 |
| monster    | proto appearance/fallback/tint/scale (+ mod tint), name colour by rarity, `bar` = hp fraction when damaged or targeted, `statusTint` (chill/poison/burn) |
| npc        | npc appearance, label always                                                                                                                             |
| loot       | `loot.gold`, `loot.potion.<kind>`, `loot.item.<weaponClass or category>`; `showLabel`, `labelColor` by rarity                                            |
| projectile | `kind: "projectile"`, appearance = sprite id, `zLift 24`                                                                                                 |
| portal     | `fx.portal` prop                                                                                                                                         |

Map: `renderer.setMap(getAreaMap(...))` when the area changes, then `snapCamera(hero)`;
`setLighting({darkness: theme.darkness/100, radius: lightRadius})` (town 0). Camera follows the
interpolated hero position.

Events → visuals: `classic.hit` → `floatText` (element colour, crit = size l + "!") and a small
`hit` effect; `classic.miss` → "miss"; `classic.effect`/`classic.cast` → `playEffect` via an
effect table (`fx.frost_ring` → nova cold, `fx.cinder_orb` → explosion fire, `fx.arc_chain` → chain,
`fx.phase_step`/`fx.tumble` → blink, `fx.mend` → heal, `fx.whirl`/`fx.slam` → nova, `fx.burst` →
explosion poison, `fx.rally` → levelup ring, `fx.charge` → slash, default → cast flash);
`classic.levelUp` → levelup effect + toast; `classic.gold` → "+N" gold float text; deaths, loot,
quests and area changes → combat log and toasts.

### 12.4 Input (`input.ts`)

| Input                                         | Action                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Left click / tap on monster                   | `useSkill` bar slot 1 (`attack` default), `repeat` while held              |
| Left click / tap on loot / NPC / interactable | `pickup` / `interact`                                                      |
| Left click / tap on ground                    | `moveTo` (held: re-issue every 250 ms toward the pointer)                  |
| Shift + left click                            | slot 1 at the point (stand still)                                          |
| Right click                                   | slot 2 at the hovered monster or point                                     |
| 1–6                                           | cast that slot at hovered monster / nearest enemy in range / pointer point |
| Q W E R                                       | drink belt slot 1–4                                                        |
| C I S L                                       | character / inventory / skills / quests panels; Esc closes all             |
| M / Tab                                       | minimap toggle / large automap overlay                                     |
| T                                             | town portal                                                                |
| Space                                         | cycle Manual → Auto → Idle; `+`/`-` change idle speed                      |

Picking: nearest unit/loot/npc/interactable to the pointer's fractional tile within 0.8 tiles
(units preferred). Hovered entity is highlighted and shown in the target bar.

### 12.5 Renderer extension (`ArpgWorldRenderer`, T8)

Defined in `packages/ui-host/src/render.ts` (contract, done): `ArpgRenderEntity` (kind, action,
fallbackAppearance, tint, scale, alpha, bar, labelColor, showLabel, highlight, dead, zLift,
statusTint), `floatText`, `playEffect`, `onPointer`, `snapCamera`, `setZoom/getZoom`, `setLighting`,
`tileAtClient`, `stats`, `isArpgRenderer`. Implementation requirements:

- **Chunk culling**: ground in 16×16-tile chunk containers (`cacheAsTexture`), objects as sprites per
  chunk in the sorted world layer, built lazily only for chunks within the view + 1 chunk margin;
  destroyed when they leave a 2-chunk margin. Rebuild check only when the camera crosses a chunk.
- Entities: culled outside the view; depth-sorted by `depthOf`; health bars and labels drawn in
  per-entity Graphics/Text created once and updated only when values change.
- Animation resolution with fallback chain (see the doc comment of `ArpgRenderEntity.action`), tint,
  scale; primitive fallback shapes coloured by tint.
- Float texts and effects from small pools (no per-frame allocations); effects drawn with Graphics.
- Lighting: one radial darkness overlay (a cached texture) centred on the followed point.
- `tile.void` and unknown ground ids: dark fallback colours; walls without art: a tall box
  primitive coloured by theme.
- Keep the base `WorldRenderer` behaviour so steps/duel/town keep working.

---

## 13. HUD (T9)

React, game state only through `api.hud` / `api.log` / `api.ui` with `useSyncExternalStore` and
selectors (shallow compare) — never re-render at 60 fps. Slots (registered by
`registerDefaultHud(slots)`, other modules can `replace`/`remove`):

| Slot                      | Default widgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic.hud.top`         | AreaBanner (area name, depth, explored %), ControlBar (Manual / Auto / Idle segmented control, speed ×1/×2/×4/×8 when Idle, auto plan label), PerfOverlay (settings.showPerf)                                                                                                                                                                                                                                                                                                                                                               |
| `classic.hud.topRight`    | Minimap (canvas, explored tiles, dots for monsters/champions/boss/NPCs/loot/stairs/waypoint/portal; redraw at 5 Hz)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `classic.hud.target`      | TargetBar (name coloured by rarity, mods, life bar)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `classic.hud.left`        | QuestTracker, CombatLog (collapsible, last 8 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `classic.hud.bottom`      | LifeOrb, SkillBar (6 slots, key labels, mana cost, cooldown sweep via conic-gradient, unusable dimmed), Belt (4, counts, Q W E R), XpBar, ManaOrb, PanelButtons                                                                                                                                                                                                                                                                                                                                                                             |
| `classic.hud.overlay`     | NewHeroScreen (phase "choose": class cards + name → `classic.newHero`), DeathScreen (respawn countdown + button), Toasts (level up, quest, area, loot uniques, offline summary), Tooltip (item, compare with equipped), ErrorFlash                                                                                                                                                                                                                                                                                                          |
| `classic.panel.<PanelId>` | character (attributes with + buttons, derived stats, resists), inventory (paper doll + 10×4 grid, click to equip/unequip, drag or click-select to move, right-click/long-press menu: equip, drop, sell when vendor open, stash), skills (list, rank, learn +, assign to bar slot), quests, vendor (smith stock buy, alchemist potions/scroll buy, junk buyer sell list), stash, waypoint (unlocked depths → `useWaypoint`), settings (damage numbers, loot labels, minimap, zoom, lighting, perf, auto config editor, new game), log (full) |

Orbs: radial fill (life red, mana blue) with value text. Rarity colours `RARITY_COLOR`, monster
colours `MONSTER_COLOR`. Item glyphs: inline SVG per category coloured by rarity (no art needed).
Layout: desktop bottom bar centred (orb 96 px, skill 52 px); compact (< 700 px, `ui.compact`): orbs
64 px in the bottom corners, skill row (6 × 44 px) and belt row above, panels as full-screen sheets,
log hidden by default, minimap 96 px. All touch targets ≥ 44 px. Fonts: system UI; dark translucent
panels with a warm gold accent (original style).

---

## 14. Art (T11)

Logical ids (renderer fallbacks keep the game playable when any is missing):

- Ground: `tile.grass`, `tile.grass.dark`, `tile.dirt`, `tile.stone`, `tile.void`,
  `tile.crypt.floor[.1-.3]`, `tile.cave.floor[.1-.3]`, `tile.forge.floor[.1-.3]`, `tile.abyss.floor[.1-.3]`.
- Walls (objects): `wall.crypt`, `wall.cave`, `wall.forge`, `wall.abyss` (fallback `wall.dungeon`).
- Props: `prop.door`, `prop.stairs.down`, `prop.stairs.up`, `prop.waypoint`, `prop.stash`,
  `prop.barrel`, `prop.crate`, `prop.pillar`, `prop.bones`, `prop.torch`, `prop.brazier`,
  `prop.house`, `prop.house.large`, `prop.well`, `prop.fence`, `prop.tree` (exists),
  `prop.tree.pine`, `prop.rock`, `prop.cart`, `prop.tent`, `prop.statue`.
- Units: `unit.hero` (exists), `unit.hero.warrior|rogue|sorcerer`, `unit.npc.healer|smith|alchemist|junk|quest`,
  `unit.monster.<id>` for every monster and boss; animations `<id>.idle`, `.walk`, `.attack`,
  `.death`, optionally per facing.
- Loot: `loot.gold`, `loot.potion.life|mana|rejuv`, `loot.item.<sword|axe|mace|dagger|bow|staff|wand|shield|helm|armor|gloves|boots|ring|amulet>`.
- FX: `fx.arrow`, `fx.ember_bolt`, `fx.cinder_orb`, `fx.frostbolt`, `fx.firebolt`, `fx.shadebolt`,
  `fx.spark`, `fx.venom`, `fx.portal`.

Sources: Kenney CC0 packs (Isometric Miniature Dungeon for floors, walls, stairs, props and the
character frames; Isometric Landscape/Nature/Buildings for town). Monsters without art are generated
by the build script as recoloured/rescaled variants of Kenney character frames (distinct hue per
family) so each id exists; the renderer additionally tints/scales via `fallbackAppearance`.
Licences recorded in `modules/art.kenney/LICENSES.md`. Atlas pages ≤ 2048².

---

## 15. Auto and Full Idle (T7)

### 15.1 Control

`ControlState {mode, speed, overrideUntil, config}`; a new game starts in **Auto** (the hero plays
itself until the player picks Manual or clicks; default `explorePct` 35). `classic.setControl` (any time; switching to
manual or auto resets speed to 1), `classic.setSpeed` (1/2/4/8; `ERR.modeNotIdle` unless idle),
`classic.setAutoConfig` (validated partial). Speed is host-side: the client steps `speed` ticks per
50 ms (the sim never reads it except for validation); the server later checks tick rate ≤ 8 × wall.

### 15.2 The controller (`classic.auto.think`, part of the sim)

Runs when `autoActive(world, tick)`. Reacts every tick to danger; full re-plan every 10 ticks
(`AutoState.thinkAt`). Priority list (first that applies wins):

1. **Dead** → after `respawnDelay` push `{op:"respawn"}`.
2. **Busy** (Casting/Dash) → nothing (potions still allowed).
3. **Potions**: life < `lifePotionPct` (strictly below; default 50) → drink the lowest-tier life/rejuv
   potion that is not wasted (belt cooldown ready); mana < `manaPotionPct` → mana potion. A drink
   that restores nothing (life or mana already full) is refused by the op (`potion_useless`, nothing
   consumed), and Auto never queues one. A life potion adds exactly its amount, capped at max
   (`classic.potion` carries `lifeBefore`/`lifeAfter`).
4. **Retreat**: life < `retreatPct`, no life potion, in the dungeon, scroll available → `townPortal`.
5. **Fight**: awake hostile units within 12 tiles with LOS, plus the living owner (≤ 18 tiles, no
   LOS needed) of any summon among them. Target score = distance (tiles) + 4 for a summon farther
   than 2 tiles − 6 exploder within 4 tiles − 3 caster/summoner − 2 boss/unique − 2 current focus;
   lowest wins. The fight plan holds 10 ticks after the last foe left the scan (hysteresis).
   **While leaving the level** (see 10) only foes within 4 tiles (`LEAVE_FIGHT_RANGE`) or attacking
   the hero (its `Ai.target`, state `attack`/`charge`) are engaged; the rest of the scan still
   counts for AoE, buffs and kiting.
   Skill choice over the bar's known skills (affordable: mana − cost ≥ reserve, except basic attack):
   heal when life < 60 %; buff when not active and enemies within 6; summon when below max; AoE when
   enemies within its area ≥ `minTargets`; mobility to close > 5 tiles (melee) or escape (ranged,
   ≥ 2 enemies adjacent, life < 50 % → blink/tumble 6 tiles away); best single-target by
   `priority` (a damage-over-time skill is skipped while its status still runs on the target for
   more than a quarter of its duration); else basic attack. Ranged classes kite: enemy melee within 2 tiles → move 4 tiles
   away (≤ once per 20 ticks).
6. **Loot**: no awake enemy within 6 tiles and no watchdog stall → nearest Loot within 12 tiles (the
   loot being walked to stays eligible up to 24) passing the filter (gold, potions when the belt has
   room, items ≥ `pickupRarity` that fit) → `pickup` intent. While leaving the level only loot
   within 3 tiles (`LEAVE_LOOT_RANGE`).
7. **Equip**: any bag item with `itemScore` > equipped by 5 % and requirements met → `equip`. A
   weapon keeps the current weapon style (bow, other ranged, melee). `itemScore` weighs weapon
   damage ×3 for str/dex classes.
8. **Go to town** (plan toTown), at most once per 60 s after a town visit (`AutoState.tripAt`) and
   never during a watchdog stall. Trip reasons, checked in this order (`townTripReason`):
   - `bag full`: bag cannot fit a 2×3 item **and** the town routine would free space;
   - `quest`: a finished quest (`done`, not yet completed) whose giver exists, so the town
     routine's quests step turns it in; or a quest the hero may accept now (level ≥ `reqLevel`,
     `after` done, neither active nor completed) whose giver exists, so the quests step accepts it.
     Like every trip reason it is only checked at a safe point (no foe engaged), after the trip
     cooldown and outside a stall; once accepted the quest is active and the reason is gone;
   - `restock`: no life potion and gold ≥ the price of the life potion the routine would buy now.

   The trip uses `townPortal`; with no scroll it walks to this level's waypoint, else keeps playing.

9. **Town routine** (depth 0, `todo` = heal → sell → stash → buy → smith → quests → return): walk to each
   NPC (`interact` intent) and queue the ops: heal; sell items below `keepRarity` that are not
   upgrades, and kept rarities that no longer fit the stash (`classic.auto.notice` "stash_full");
   stash the rest that are not upgrades; buy potions first when the belt has no life potion, else 2
   scrolls first (class plan: Sorcerer 2 life + 2 mana slots, others 3 life + 1 mana; the best
   affordable unlocked tier up to the level's tier: < 10 minor, < 20 light, < 30 greater, else
   super), scrolls up to 5; a smith item that is an 8 % upgrade (3 % when gold covers 3× its price)
   within the gold left after a reserve of 10 tier life potions + 2 scrolls; accept available quests
   and complete done ones; return: open portal → `usePortal`, else waypoint to the deepest unlocked
   waypoint (≤ `maxDepth`, monster level ≤ effective level + 2, and below the depth of a death the
   hero has not been back to), else the town exit stairs.
10. **Boss / descend**: once explored ≥ `explorePct` (or no reachable frontier): on a boss depth with
    the boss alive and the hero ready (effective level ≥ `monsterLevel(depth) + 2`) → walk straight
    to the boss. Descend when `autoDescend`, `maxDepth` respected, effective level ≥
    `monsterLevel(depth + 1) − 2` and no living boss (or the hero is ready for the next depth's
    level + 2) → interact stairsDown. Otherwise (under-levelled, at maxDepth, not ready for the
    boss) → stairs up then down again (fresh population) to farm.
    **Leaving the level** (`AutoLeave` on the hero: `{plan, depth}`): set while the plan is
    descend or toTown, kept through the fight and loot plans that interrupt the walk, removed on
    any other plan or area change. While it holds, steps 5 and 6 stay close (see above), so a
    crowded level (≈190 spawns on a Crypt level) no longer keeps the hero from the stairs.
11. **Explore**: BFS from the hero tile (≤ 8 000 nodes) to the nearest frontier (explored walkable
    tile next to an unexplored walkable tile) not in `ignore`; move intent there; re-plan when within
    2 tiles, every 40 ticks, or when stuck (same tile 40 ticks while moving → add to `ignore`).

Normal-rarity items are left on the ground by default: `pickupRarity` defaults to `magic` (a user
setting), so Auto only picks up magic and better unless the player lowers it.

**Progress watchdog** (`AutoState.hops/killAt/stallUntil`): 6 area changes without a kill (a travel
loop) or 2 minutes in a dungeon without a kill (a drought) start a 3-minute **stall**: no voluntary
town trips, no looting, the ignore list is cleared and the dungeon routine heads for the stairs (a
fresh level). Emits `classic.auto.notice` ("travel_loop" / "no_kills").

**Death caution** (`AutoState.caution`, 0–3): +1 per death, −1 per level up. The controller plans
with `effectiveLevel = level − 2 × caution` (descend, boss readiness, waypoint choice), and the
first return after a death goes below the depth of that death (a fresh level, not the pack that
won).

All decisions read world state only, so the controller is deterministic and replayable. It emits
`classic.auto.plan` when the plan changes (for the HUD label and debugging).

### 15.3 Auto allocation (`classic.auto.allocate`)

When `config.autoAllocate` and mode ≠ manual: spend stat points per `autoAlloc` (in a fixed str →
dex → mag → vit cycle by weight), skill points over the learnable `autoSkillOrder` entries (a skill
at rank 0 first; else the lowest `2 × rank + order index`, so points spread over the top skills),
and put newly learned skills in empty bar slots.

### 15.4 Offline progress (`classic.offlineProgress {elapsedMs}`)

Deterministic rate model; `ms = min(elapsedMs, offlineCapMs)`, `minutes = floor(ms / 60000)`:

- depth = deepest unlocked waypoint depth with `monsterLevel(depth) ≤ heroLevel + 1` (≥ 1).
- `dps` = average damage of the best affordable bar skill (`rollSkillDamage(..., null)`) ×
  `20 / castTicks(scaled)`; `avgLife` = mean scaled life of the theme's monsters at that depth.
- `killsPerMin = clamp(floor(dps × 60 × offlineEfficiencyPct% / avgLife), 1, 120)`; kills =
  `killsPerMin × minutes`.
- XP = kills × average `xpForKill`; gold = kills × 45 % × average gold drop; items = `floor(kills ×
  0.02)` capped at 20, rolled magic+ → `{op:"grantItems", toStash: true}`; the rest auto-sold.
- Queues `grantXp`, `grantGold`, `grantItems`; emits `classic.offline.summary`; adds `RunStats.offlineMs`.

---

## 16. Quests (T1 data, T6 runtime)

Kinds: `killBoss` (boss monster id), `clearLevel` (depth: kill 100 % of a live level at that depth),
`reachDepth` (depth), `killMonsters` (monster id or `*`, count). Chain (`after`). At least 8 quests,
e.g. "Rats in the Cellar" (kill 20 gnawlings), "The Warden's Rest" (kill boss_warden), "Deeper
Still" (reach depth 6), "Ash and Ember" (kill 15 ash seers), "Tunnel Mother" (boss depth 8),
"Ninth Flame" (boss depth 12), "Crown of Hollows" (boss depth 16), "Clear the Crypt" (clear depth 3).
Accept at the quest giver; progress from `Bus.deaths` and transitions; `done` → turn in for gold,
XP and an optional item (`grantItems`). Events `classic.quest.*`.

---

## 17. Performance budget

| Item                          | Target                                | How                                                                                                                         |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sim tick                      | < 2 ms with 300 monsters on the level | sleep beyond 20 tiles, staggered wake/think, spatial grid, distance field, A* budget, no per-tick allocations of big arrays |
| Kernel snapshot per `step(k)` | < 1 ms                                | maps outside the world, small resources, one `step(k)` per frame                                                            |
| Map generation                | < 30 ms per 128×128 level             | single pass + BFS, memoised                                                                                                 |
| Client                        | 60 fps desktop and iPhone 14 class    | chunk culling, entity culling, upsert only changes, pooled texts/effects, HUD at 10 Hz                                      |

Tests: `tests/monsters.perf.test.ts` (300 monsters, hero in the middle, 200 ticks; assert mean
< 4 ms/tick on CI to avoid flakiness, log the real number), `tests/world.test.ts` (generation time).
A browser bench in `tools/bench` comes with integration.

---

## 18. Testing and gates

- Each builder: `node_modules/.bin/vp test run modules/classic/` (own files pass) and
  `node_modules/.bin/vp check` (0 errors in own files).
- Unit tests use `tests/support/harness.ts` (`testSim([...moduleIds])`, `useOpenMap`,
  `spawnTestHero`, `spawnTestMonster`) and the test content by default, so they never depend on
  another builder's unfinished module. Content-specific tests use `{ content: "real" }` and must only
  rely on `classic.content` + the tester's own module.
- Required per module: behaviour tests, a determinism test (two sims, same seed and script → same
  hash), a pinned hash after a fixed script, rejection tests for actions (`ok: false`, hash
  unchanged).
- Integration (done, see §21.3): `tests/autoplay.test.ts` (20 sim minutes per class in Auto),
  `tests/autoplay.replay.test.ts` (replay and mid-run snapshot restore), `tests/auto.play.test.ts`
  and `tests/client.bundle.test.ts`.

---

## 19. Implementation split (this workflow)

| Task             | Model     | Owns                                                                                                                               |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| T1 content       | Haiku 5.5 | `src/content/**`, `tests/content*.test.ts`                                                                                         |
| T2 world         | Haiku 5.5 | `src/world/**` except `maps.ts`, `tests/world*.test.ts`                                                                            |
| T3 core + combat | Opus 5.5  | `src/core/**` except `infra.ts`, `src/combat/**`, `tests/core*.test.ts`, `tests/combat*.test.ts`                                   |
| T4 monsters      | Haiku 5.5 | `src/monsters/**`, `tests/monsters*.test.ts`                                                                                       |
| T5 items         | Haiku 5.5 | `src/items/**`, `tests/items*.test.ts`                                                                                             |
| T6 progression   | Haiku 5.5 | `src/progression/**`, `tests/progression*.test.ts`                                                                                 |
| T7 auto / idle   | Opus 5.5  | `src/auto/**`, `tests/auto*.test.ts`                                                                                               |
| T8 renderer      | Haiku 5.5 | `apps/game/src/client/render/**`, `apps/game/tests/client/render*.test.ts`                                                         |
| T9 HUD           | Haiku 5.5 | `src/client/hud/**`, `tests/hud*.test.ts(x)`                                                                                       |
| T10 client view  | Haiku 5.5 | `src/client/{index,game,loop,scene,input,persist,hudModel,describe,effects}.ts`, `modules/classic/dev/**`, `tests/client*.test.ts` |
| T11 art          | Haiku 5.5 | `modules/art.kenney/**`, `apps/game/public/art/kenney/**`                                                                          |

---

## 20. Clarifications (binding for builders)

- **Exploders** (combat): after a caster with `MonsterProto.behaviour === "exploder"` fires its
  `onDeathSkill`, combat kills it (`Dead.killer = itself`, `creditTeam: "monster"`, no XP or loot).
  `classic.monsters.onDeath` skips `onDeathSkill` when `killer === entity`.
- **Monster death bursts** (monsters): damage = `rollSkillDamage(skill, 1, deadMonsterStats, null,
  ctx.rng)`, one `HitRequest` per hero-team unit within `skill.radius` of the death point, plus a
  `classic.effect`.
- **Wallet writes**: items owns `Wallet`; progression may decrement `Wallet.gold` directly for the
  death penalty. `grantGold.amount` may be negative (balance clamps at 0).
- **Vendor restock** (items, in `classic.items.heroInit`): when the hero exists, the area is the
  town and either the stocks are empty or `AreaState.enteredAt === ctx.tick`, roll every NPC stock
  with `sells.count > 0` at `ilvl = monsterLevel(max(1, deepest))` (70 % normal, 30 % magic).
- **Boss summons** (monsters): bosses cast their summon skill whenever it is ready, their life is
  below 90 % and fewer than `max` minions are alive (no phase flags needed).
- **Boss spawned event**: `classic.monsters.spawn` emits `classic.boss.spawned` when it creates a
  `boss` rarity monster. `DungeonState.liveBossAlive` is set by world when it queues the boss.
- **Basic attack**: a skill with `shape: "melee"` and `range: 0` is the weapon attack: reach =
  `CombatStats.attackRange`, ticks = `CombatStats.attackTicks`; when `attackProjectile !== ""` it
  fires that projectile (speed 80, radius 64, max range = attackRange) instead of a melee hit.
- **Self skills with `target: "self"`** (nova, pulse, aoeTarget-at-self such as `burst`) need no
  target in the CastOrder and fire at the caster position.
- **Hero summons** get `level = hero level`, `rarity: "summon"`, `team: "hero"`, `owner = hero`.

---

## 21. As built (phase 2a integration)

### 21.1 What exists

- `@gamez/mode-classic` exports `modules` (content, core, world, combat, monsters, items,
  progression, auto), `mode` (id `classic`, fixed 20 Hz, `classic.*`) and `./client` →
  `classicView`. All eight modules load together with `loadMode(mode, modules)`; there are no stubs
  left in `src/`.
- Content: 3 classes, 15 hero skills + 17 monster skills, 12 monsters + 4 bosses (depths 4/8/12/16),
  9 monster mods, 44 item bases, 68 affix tiers, 15 uniques, 10 quests, 5 NPCs, 5 themes.
  Depth 1 already has five monster types (husk, gnawling, bonefletcher, ash seer, hollow cantor).
- World: 72×72 town, 128×128 dungeon levels (18-26 rooms, 28-40 packs, up to 300 monsters), stairs,
  waypoints on every odd depth, town portals, exploration fog, boss levels.
- Client: local sim with a fixed 20 Hz loop and interpolation, Pixi ARPG renderer (ground chunks,
  lighting, effects pool, floating numbers), React HUD (orbs, skill bar, belt, XP bar, control bar,
  minimap/automap, target frame, quest tracker, combat log, character/inventory/skills/quests/
  vendor/stash/waypoint/settings panels), keyboard and pointer input, autosave to localStorage and
  offline progress on return. Dev harness: `node_modules/.bin/vp dev --config
  modules/classic/dev/vite.config.ts --port 5180` (imports `@gamez/mode-classic/client`).

### 21.2 Integration changes (made while wiring everything together)

- **Bus carry** (`core/infra.ts`): commands pushed after the command systems (core.intent arrivals
  at update 100: pickup, heal, stairs, usePortal; quest rewards at update 52) and hits pushed after
  resolveHits (on-death bursts at update 750) used to be dropped at cleanup. They now get one more
  tick and are dropped (with `classic.command.failed`) only at their second cleanup.
- **Auto aim**: projectile and aoeTarget point casts keep the target entity, so combat aims at where
  the target is when the skill fires (moving targets used to dodge most bolts).
- **Defaults**: new games start in Auto; `explorePct` 80 → 35 so the hero dives instead of clearing
  every 128×128 level.
- **Balance**: XP curve above; ember bolt speed 70 → 100; hunting bow 3-7 dmg at 11 ticks (was 2-6
  at 13); multishot 75 % weapon (was 60 %); rogue life 48 + 3/level (was 40 + 2/level); ash seer
  2-4 dmg from depth 1 (weight 6); hollow cantor from depth 1 (weight 6).
- **Renderer**: one-shot effects only use exact sprite ids, so effects without art are drawn
  procedurally instead of as the "missing" checkerboard.
- **Combat log**: auto plan changes log readable lines (town trips, descents) instead of raw notes.
- **Art build** runs the repo formatter on `manifest.json` so `vp check` stays green after a rebuild.
- Performance tests assert 2× their budget (budget still logged) so a loaded shared machine does not
  flake them.

### 21.3 Measured (seed 2026, 24 000 ticks = 20 sim minutes in Auto, `tests/autoplay.test.ts`)

| Class    | Level | Kills | Monster types | Skills used | Deaths | Max depth | Avg tick |
| -------- | ----- | ----- | ------------- | ----------- | ------ | --------- | -------- |
| Warrior  | 7     | 408   | 5             | 4           | 5      | 2         | ~1.2 ms  |
| Rogue    | 7     | 301   | 5             | 5           | 0      | 4         | ~1.1 ms  |
| Sorcerer | 8     | 418   | 5             | 4           | 1      | 4         | ~1.0 ms  |

(After the §21.4 playtest fixes. Before them: warrior 6/312/3 deaths/depth 3, rogue 6/219/3/2,
sorcerer 8/268/0/4. The test's thresholds with the least margin are the warrior's 5 monster types
and max depth 2; Hollow Cantor now starts at depth 2. Avg tick measured with the suite running in
parallel; alone it is ~1.0-1.2 ms.)

Every class drinks potions, picks up and equips items, and makes town trips that sell and buy.
Determinism: the same seed replays to the same hash whether stepped 1 or 20 ticks at a time, and a
JSON round-tripped snapshot taken at tick 12 000 restores to the same hash and continues to the same
final hash. Full Idle offline progress grants XP, gold and stash items, is capped at 8 h and is
deterministic. The worst single tick (~50-70 ms) is the 128×128 level generation on an area change.

### 21.4 Playtest fixes (phase 2a playtest round)

Three headless playtests (progression/balance, stability/performance, content/UI; ~10 h of sim)
found two town livelocks, unbeatable bosses and a depth-4 progression wall. Fixed, each with a
regression test (`tests/auto.regress.test.ts` unless noted):

- **Town livelocks**: the restock trigger now uses the price of the potion the routine would buy
  (best affordable unlocked tier), potions come before scrolls with an empty belt, the stash-full
  case sells kept rarities (`classic.auto.notice` "stash_full"), a bag-full trip needs something the
  town can free, and voluntary trips wait 60 s after a town visit.
- **Progress watchdog** (§15.2): travel loops and kill droughts start a 3-minute stall.
- **Bosses**: hunted as soon as `explorePct` is met and the hero is ready; Tremor no longer
  stun-locks (cooldown 120, stun 16) and every boss attack has a cooldown; summons at 66/33 %
  (`Ai.count`); wounds kept across level re-entry (`DungeonState.bossWound`); the way down waits
  for a boss the hero is not ready for (no stairs ping-pong). Boss display name no longer doubles
  the title (`rules.bossDisplayName`).
- **Deaths**: champion/unique packs ramp in over depths 1–2 (`packRampDepth`), Hollow Cantor from
  depth 2, death caution (§15.2), waypoints on every odd depth.
- **Movement**: a wall slide counts as blocked, so the hero executor switches to A* instead of
  sliding on a corner the thin line of sight calls clear (seen as a never-ending walk to a
  waypoint); once following a path it keeps it (`core/movement.ts`, `core/intent.ts`).
- **Summoners**: raise only with the target within 9 tiles and in LOS; the auto hero hunts the
  owner behind its summons and deprioritises summons (they give no XP).
- **Combat**: single exploding projectiles fired at a unit home on it (1 angle step per tick, at
  the skill's speed; Cinder Orb speed 56); overkill leaves life at 0 (`tests/combat.test.ts`).
- **Class balance**: sorcerer primary `mag`; rogue mana 20/2/2, autoAlloc 1/3/0/1, hunting bow
  4–8 at 11 ticks, Fan of Arrows 4 mana / 85 %, Venom Shot 110 % with a 60-tick poison (and the
  auto skips a DoT skill while its status runs); warrior mana 10/1/2, Whirling Steel priority 6.
  Gear: weapon damage weighs ×3 for str/dex classes and a weapon keeps its style (bow / other
  ranged / melee) — rogues used to swap their bow for wands.
- **Skill points**: new skills get a point at once, then points spread (`2 × rank + order index`).
- **Economy**: smith stock 12 items incl. jewelry and 15 % rares, bought within a potion reserve
  with a smaller margin when rich; alchemist tiers unlock by hero level (op and HUD).
- **Town ops**: quests need the giver within reach.
- **Tank**: slams as every 4th attack.
- **HUD/client**: bag cells fit the viewport (32 px at 375 px wide, `bagCellSize`), a status bar
  (`classic.statusBar` in `classic.hud.target`, `HeroView.statuses`), effect rows for every skill
  effect id, the combat log fills its column (Full log no longer clipped), notices in the log.

Playtest after the fixes (`/tmp` harness, Auto from a fresh hero, seeds 2026/7/99/13, 60 sim min):

| Class    | Level at 60 min | Level 10 at | Kills/min | Deaths/h | Deepest | Depth-4 boss killed |
| -------- | --------------- | ----------- | --------- | -------- | ------- | ------------------- |
| Warrior  | 10–14           | 37–47 min   | 18–19     | 1–5      | 4–8     | 5 of 6 runs         |
| Rogue    | 13–14           | 29–37 min   | 9–11      | 0–2      | 7–8     | 4 of 4              |
| Sorcerer | 16–17           | 20–30 min   | 24–26     | 3        | 8       | 4 of 4              |

150-minute runs (warrior 99, rogue 2026, sorcerer 7): level 19–22, depth 10–11, depth-8 bosses
killed, full stash handled (no livelock), longest kill gap ≤ 99 s, 4–6 deaths per hour.

### 21.5 Known gaps (next phases)

- Not wired into `apps/game` (catalog, mode list, InstanceDO verification/persistence).
- Kernel cost: reading a big component in a transaction copies it (~5 µs for `CombatStats`), so a
  `step(1)` per tick costs ~2× a batched `step(k)`. A read-only accessor in the kernel would help.
- Level generation causes a one-frame hitch on area changes; pre-generate the next level or spread
  the work.
- Monster archers can shoot into wall corners that `lineOfSight` reports as clear (the hero's
  controller uses a wider clear-shot check; monster AI does not yet).
- Core A* (6 000 nodes) can fail on very long paths across a 128×128 level; the auto controller
  walks in ≤ 16-tile legs, but a manual click on a far tile may not path.
- Contract gaps from content: no per-skill knockback (fixed 1 tile for damaging dashes), no
  per-element resist on monster mods, weapon-percent skills take the monster element.
- The healer NPC has no explicit heal action (healing happens on interact).
- Balance is checked to depth ~11 (150-minute runs); depths 12+ (Vessa, the Hollow King, the abyss
  tier) are untested in long runs. Pace: depth 2–4 in 20 minutes, 7–10 in 60.
- Gold sink: the sorcerer still keeps 45–70 % of the gold it earns after an hour (warrior and rogue
  2–57 %); it rarely finds smith upgrades. A gamble vendor or repair costs would add a sink.
- The rogue kills about half as fast as the sorcerer (9–11 vs 24–26 per minute) but levels on par
  with the warrior thanks to fewer deaths and deeper depths.
- The previous dungeon level stays in the ECS (and in snapshots, up to ~150 KB) while the hero is
  in town, so a portal returns to it; it is destroyed only when another depth is entered.
- The progress watchdog counts kills only: retreat-heal-return cycles against a boss (no potions)
  can be flagged as a travel loop even while the boss loses life.
- Monster roster: several behaviour clones (husk/cinder imp rushers, gnawling/webskitter swarms,
  ash seer/rime wraith casters) and theme tiers gate first appearances beyond `minDepth`
  (cinder imp and rime wraith first at depth 9).
- Skill points can go to skills that have no free bar slot (the sorcerer's Phase Step); mobility
  skills are only used to escape at low life.
- Dungeon walls are slightly shorter than heroes. Monster art is derived procedurally from one
  Kenney character (distinct silhouettes, not bespoke art).

### 21.6 Browser QA round 1 (`tools/qa`, headless Chrome against the dev server)

A headless-browser QA pass (animations, labels, panels, spells, art coverage, performance) found
and fixed:

- **Art** (`modules/art.kenney`): the 8 Kenney views are one character seen from 8 directions
  (0 = ne, clockwise). Every unit now has `<id>.<action>.<facing>` for all 8 facings; fighters get
  idle, walk, attack (impact on frame 2), cast, hit and death (ends on a full-alpha corpse); the
  unsuffixed clip is the south one. Families get procedural silhouettes (hunch, ears, legs, hoods,
  horns, crowns…). Trimmed frames with one source box per unit; 4 atlas pages ≤ 2048².
- **Renderer** (`apps/game/src/client/render`, contract `render.ts`): new optional fields
  `actionProgress`, `animRate`, `hitFlash`, `vx/vy`, `subtitle`, `marker`, `labelPriority`.
  Lookup: cast → `cast.<f>`, `cast`, `attack.<f>`, `attack`, idle; hit → `hit`, idle; bodies
  mirror for w-side facings only when the clip has no facing suffix. Labels live in their own
  layer above sprites, start at the visible top of the trimmed sprite, loot labels are
  de-overlapped by rarity rank (hero name as a fixed obstacle) and every label is kept inside the
  view. Hits flash red with a 1–2 px knockback; projectiles rotate along their heading; dead units
  without a death clip fade and squash; nearby floats are staggered.
- **Scene** (`scene.ts`): animation time runs on sim ticks (`tick - 1 + alpha`), the hit tick is
  the middle of the swing, a finished swing holds 2 ticks, hits drive a 4-tick flash and a 3 s
  nameplate, corpses fade over their last 10 ticks. Nameplates: uniques and bosses always, one per
  champion pack (lowest entity id), normal monsters when targeted, hovered or hit. NPC titles show
  as subtitles; the quest giver shows `!`/`?` (same rules as Auto); stairs and the waypoint are
  always labelled, portal and stash within 5 tiles, the nearest within 3 says "click/tap to use".
- **Floats** (`effects.ts` `floatPolicy`, applied in `game.ts`): from Full Idle x4 small floats
  (miss, dots) are dropped, floats live 700 ms (x4) / 550 ms (x8) and each frame's batch is capped
  at 8 / 6, so x8 combat stays readable.
- **Sim/Auto**: Auto turns in finished quests (trip reason `quest`); a potion that restores
  nothing is refused (`ERR.potionUseless`, not consumed, no cooldown); `classic.potion` carries
  `lifeBefore/After`, `manaBefore/After`; unknown art falls back to `unit.unknown` → `missing`.
- **HUD**: toasts clear the minimap (desktop) and the bottom bar (phone), the classic view owns its
  exit control (`ClientModeView.ownsExitControl`), a short-landscape layout (< 500 px tall), opaque
  phone panels, distinct minimap markers, a 6-entry combat log; tooltips read "Magic Boots ·
  Sandals", "Armor" spelled one way, item comparison against the equipped item, per-skill glyphs
  in the Skills panel and the skill bar, 44 px bag cells (the bag scrolls sideways at 375 px).
- **Effects**: failed hero casts show an error flash with a readable reason; no float for a
  0-amount heal; level-up toast pluralised; distinct colours for whirl/charge/tumble/claw/rally.
- **QA tooling**: `?qa=gallery` lays out every appearance × action × facing, item, effect, tile and
  prop with what each id resolved to; the harness records long frames and longtasks split at 5 s
  and survives dev-server reloads in long scenarios (`tools/qa/README.md`).

Open after round 1: monster nameplates other than champion packs are not de-overlapped; the hit
flash is a red multiply tint (a white flash needs a filter); atlas PNGs total ~18 MB (WebP/KTX2 or
a half-resolution mobile atlas would cut it); float texts re-rasterise a Pixi `Text` per spawn
(a BitmapText font would be cheaper); headless x8 runs on software GL show multi-second longtasks
that still need profiling on real hardware.

### 21.7 Browser QA round 2 (sim: auto descend, quests, cleave)

- **Idle descends**: with seed 4242 Idle never took the stairs (fights within 12 tiles always
  preempted the descend plan). Now the descend/toTown commitment (`AutoLeave`, §15.2 step 10)
  limits fights to foes within 4 tiles or attacking the hero and loot to 3 tiles. Headless, seed
  4242: warrior reaches depth 2 at ~7 300 ticks, sorcerer ~7 350, rogue ~9 100
  (`tests/qa-r2.sim.test.ts`).
- **Quest acceptance**: a quest the hero newly qualifies for (Deeper Still, reqLevel 4) is a
  `quest` trip reason (§15.2 step 8).
- **Cleave** emits one oriented `classic.effect` per swing, so misses are visible (§7.3).
