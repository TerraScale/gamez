# Wave A — classic depth and polish (design)

Status: **implemented and integrated** (2026-10-28, on top of commit 72d61b1). §14 records what was
built, the measured numbers and the known gaps.
Base design: `docs/design/classic.md` (phase 2a, read §2 determinism, §3 architecture, §15 auto,
§21 as built). Repo rules: `AGENTS.md`. Browser QA: `tools/qa/README.md`.

Goal: make classic a deep, polished, complete **single-player** idle ARPG. Everything stays local
(the browser runs the sim); server persistence and verification are wave B.

---

## 0. Scope

### 0.1 Must fix first (open QA majors)

| #   | Problem                                                                                         | Root cause (architect probe, seed 4242 warrior, headless)                                                                                                                                                                                                                                                                                                                                                                                                               | Owner           |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | Idle x8 never takes the stairs (0 descents in 5 wall minutes)                                   | (a) the plan turns to "descend" at tick ~3100 but the stairs are ~100 tiles away in the farthest room of a 128×128 level with ~190 monsters; every pack on the way interrupts, plus two `quest` town trips mid-walk: depth 2 only at tick ~7400. (b) long stretches of plan `fight` with intent `idle` (hundreds of ticks) — the hero stands still in a fight. (c) the browser ran only ~22 ticks/s at "x8" (6 887 ticks in 311 s), so the sim never got to tick 7 400. | T-auto (Opus)   |
| 2   | The toast covers the first Sell button of the junk buyer panel                                  | toasts and panels share the top area                                                                                                                                                                                                                                                                                                                                                                                                                                    | T-hud           |
| 3   | Hotkey auto-target picks the hero's own Spark Sentry                                            | `castTargetFor` iterated every `Monster`, including hero-team summons. **Fixed in the contract commit** (`game.ts`: Faction team "hero" skipped, `isLiveMonster` excludes hero summons); T-client adds the regression test                                                                                                                                                                                                                                              | T-client        |
| 4   | 26 of 32 skill effects lack art; classes/NPCs share one recoloured body; no cast/hit animations | art pack has projectile sprites only; one Kenney character                                                                                                                                                                                                                                                                                                                                                                                                              | T-art, T-render |

### 0.2 Features

Skill trees with passives (talents) and 9 more skills; item sets and more uniques; crafting at the
smith (repair, upgrade, reroll, sockets and gems); gambling vendor and repair costs (gold sinks);
stash tabs; loot filter; the endless Rift after the main dungeon with leaderboard-ready scores;
achievements; boss encounters with telegraphs and phases; procedural WebAudio SFX and ambient
music with volume settings; graphics quality settings; onboarding tips; a character stats / DPS
panel; balance (the Rogue kills about half as fast as the Sorcerer; the Sorcerer hoards 45-70 % of
its gold). Auto/Idle uses every new system.

### 0.3 Out of scope (explicitly)

- Server persistence, replay verification and anti-cheat for classic (CharacterDO / InstanceDO
  wiring) — wave B. No DO, protocol message, migration or D1 projection changes in wave A.
- Leaderboard storage and submission (the Rift produces `RiftRecord`s that a wave B projection
  will store in D1 `leaderboard_rift`; nothing is sent anywhere now).
- Account-wide achievements, cosmetics, titles shown to others, economy between players (shops,
  auction house, trade), parties, PvP, chat.
- Real-money anything; OAuth; external services. No secrets are needed in wave A
  (`docs/secrets.md` unchanged).
- Save migration across content changes beyond the dev convenience in §11.3.
- New dungeon themes or a new act; Rift pylons/shrines; item crafting from materials (salvage).

---

## 1. Ownership and parallel tasks

Contract files (architect, read-only for builders; report contract bugs instead of editing, or work
around locally and say so):

```
modules/classic/src/{types,components,resources,events,actions,bus,ids,rules,bonus,loot,index}.ts
modules/classic/src/content/index.ts, src/core/** , src/progression/**, src/world/maps.ts
modules/classic/src/client/{contract,hudModel}.ts (hudModel: T-hud may edit), src/client/model/context.ts
modules/classic/tests/support/**, tests/contract.test.ts, tests/contract.waveA.test.ts
packages/ui-host/src/render.ts
```

| Task           | Model | Owns (paths are disjoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-auto         | Opus  | `src/auto/**`, `src/client/loop.ts`, `src/content/balance.ts`, `src/content/economy.ts`, `tests/auto*.test.ts`, `tests/autoplay*.test.ts`, `tests/qa-r1.sim.test.ts`, `tests/qa-r2.sim.test.ts`, `tests/client.loop.test.ts`, `tests/balance*.test.ts`, `tests/idle*.test.ts`                                                                                                                                                                                                                                                  |
| T-items        | Opus  | `src/items/**`, `src/crafting/**`, `src/content/npcs.ts`, `tests/items*.test.ts`, `tests/crafting*.test.ts`, `tests/gamble*.test.ts`, `tests/stash*.test.ts`                                                                                                                                                                                                                                                                                                                                                                   |
| T-bosses       | Opus  | `src/combat/**`, `src/monsters/**`, `src/content/monsters.ts`, `src/content/mods.ts`, `src/content/boss.ts`, `tests/combat*.test.ts`, `tests/monsters*.test.ts`, `tests/bosses*.test.ts`                                                                                                                                                                                                                                                                                                                                       |
| T-skills       | Haiku | `src/content/skills.ts`, `src/content/classes.ts`, `src/content/statuses.ts`, `tests/content.test.ts`, `tests/content.skills*.test.ts`, `tests/skills*.test.ts`                                                                                                                                                                                                                                                                                                                                                                |
| T-talents      | Haiku | `src/talents/**`, `src/content/talents.ts`, `src/client/model/talents.ts`, `src/client/hud/panels/TalentsPanel.tsx`, `src/client/hud/panels/SkillsPanel.tsx`, `tests/talents*.test.ts(x)`                                                                                                                                                                                                                                                                                                                                      |
| T-itemcontent  | Haiku | `src/content/sets.ts`, `src/content/uniques.ts`, `src/content/gems.ts`, `src/content/affixes.ts`, `src/content/items.ts`, `tests/content.items*.test.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| T-items-hud    | Haiku | `src/client/model/craft.ts`, `src/client/model/items.ts`, `src/client/describe.ts`, `src/client/hud/panels/{CraftPanel,GamblePanel,LootFilterPanel,StashPanel,VendorPanel,InventoryPanel}.tsx`, `src/client/hud/widgets/Tooltip.tsx`, `tests/hud.items*.test.tsx`, `tests/model.items*.test.ts`, `tests/client.describe.test.ts`                                                                                                                                                                                               |
| T-rift         | Haiku | `src/rift/**`, `src/world/**` (not `maps.ts`), `src/content/rift.ts`, `src/content/themes.ts`, `src/client/model/rift.ts`, `src/client/hud/panels/RiftPanel.tsx`, `tests/rift*.test.ts(x)`, `tests/world*.test.ts`                                                                                                                                                                                                                                                                                                             |
| T-achievements | Haiku | `src/achievements/**`, `src/content/achievements.ts`, `src/client/model/achievements.ts`, `src/client/hud/panels/AchievementsPanel.tsx`, `tests/achievements*.test.ts(x)`                                                                                                                                                                                                                                                                                                                                                      |
| T-audio        | Haiku | `src/client/audio/**`, `tests/audio*.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T-art          | Haiku | `modules/art.kenney/**`, `apps/game/public/art/kenney/**`, a new dir under `/tmp/gamez-downloads/`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T-render       | Haiku | `apps/game/src/client/render/**`, `apps/game/tests/render/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T-client       | Haiku | `src/client/{game,input,scene,effects,debug,gallery,persist,index}.ts`, `src/debug/**`, `modules/classic/dev/**`, `tools/qa/**`, `tests/client.{game,input,scene,effects,persist,bundle,qa,cheats,gallery}*.test.ts`, `tests/qa-r2.client.test.ts`                                                                                                                                                                                                                                                                             |
| T-hud          | Haiku | `src/client/hudModel.ts`, `src/client/model/dps.ts`, `src/client/tips/**`, `src/client/hud/{index.tsx,layout.ts,common.tsx,styles.ts,format.ts,icons.tsx,hooks.ts}`, `src/client/hud/widgets/**` (not `Tooltip.tsx`), `src/client/hud/panels/{CharacterPanel,SettingsPanel,PanelHost,QuestsPanel,LogPanel,MapPanel,WaypointPanel}.tsx`, `tests/hud.test.tsx`, `tests/hud.layout.test.tsx`, `tests/hud-helpers.test.ts`, `tests/hud.general*.test.tsx`, `tests/client.hud.test.ts`, `tests/tips*.test.ts`, `tests/dps*.test.ts` |

All `src/`/`tests/` paths above are under `modules/classic/`. Unowned this wave: `src/core/**`,
`src/progression/**`, `src/content/{quests,names}.ts`, the rest of `apps/game`, `packages/**`.

### 1.1 Rules for every builder

1. Only touch owned paths. Others work at the same time; the live dev server on :5173 hot-reloads
   this tree, so **every saved file must compile**: write new code in new files first, wire it last.
   Never kill or restart anything on :5173. Use `node_modules/.bin/vp` (never the global `vp`).
2. Sim code is deterministic (AGENTS.md §6; classic.md §2): `ctx.rng` only, integers, sorted
   iteration, plain JSON, no `Math.random/Date/performance/timers` outside `src/client/**`.
3. **Old saves and partial module sets**: never assume a new module's `setup()` ran. Create new
   resources and components lazily in the first system run or op that needs them; read optional
   fields with `?? default`. Every new system early-outs cheaply (no hero, nothing to do).
4. **Pinned hashes you do not own**: if your intended change moves a pinned hash in a test you do
   not own (most often `tests/content.test.ts` "is identical across two loads and pinned", the
   registry hash, and the real-content `tests/autoplay*.test.ts` numbers), do NOT edit it: list the
   test, the old and the new value in your report. The integrator updates them.
5. Content ids, effect ids, art ids, action names and event types are the ones in this file and in
   the contract files. Original names only. External assets: CC0 only, downloaded into a new empty
   dir under `/tmp/gamez-downloads/`, never executed.
6. Gate: `node_modules/.bin/vp check` with 0 errors in your files, your tests pass
   (`node_modules/.bin/vp test run modules/classic/tests/<yours>` or `apps/game/tests/render`), and
   for user-visible work a QA-harness run with screenshots (`node tools/qa/src/run.ts …`, output
   dir under `/tmp/gamez-qa/waveA-<task>-…`). Report honestly: what works, what does not, numbers.
   Nobody commits; the final fixer does.

---

## 2. Data model (contract summary)

### 2.1 Registry kinds (new, `types.ts` `KIND`)

| Kind                  | Proto              | Ids                                              | Content file (owner)          |
| --------------------- | ------------------ | ------------------------------------------------ | ----------------------------- |
| `classic.talentTree`  | `TalentTreeProto`  | `classic.talents.<class>`                        | `talents.ts` (T-talents)      |
| `classic.talent`      | `TalentNodeProto`  | `classic.talent.<class>.<name>`                  | `talents.ts` (T-talents)      |
| `classic.set`         | `SetProto`         | `classic.set.<name>`                             | `sets.ts` (T-itemcontent)     |
| `classic.setItem`     | `SetItemProto`     | `classic.setItem.<name>`                         | `sets.ts` (T-itemcontent)     |
| `classic.economy`     | `EconomyProto`     | `ECONOMY_ID` = `classic.economy`                 | `economy.ts` (T-auto)         |
| `classic.rift`        | `RiftProto`        | `RIFT_ID` = `classic.rift`                       | `rift.ts` (T-rift)            |
| `classic.achievement` | `AchievementProto` | `classic.achievement.<name>`                     | `achievements.ts` (T-achiev.) |
| (itemBase)            | `ItemBaseProto`    | gems `classic.item.gem_<kind>_<tier>`            | `gems.ts` (T-itemcontent)     |
| (skill / status)      | boss skills        | `classic.mskill.boss_*`, `classic.status.enrage` | `boss.ts` (T-bosses)          |

`content/index.ts` already registers every table (stubs are empty). Content version 0.3.0.

### 2.2 Changed shared types

- `ItemRarity` gains **`"set"`** (green `0x6fe07a`), between rare and unique:
  `rules.rarityRank` normal 0, magic 1, rare 2, set 3, unique 4. `RARITY_VALUE_MULT.set = 12`.
  `BalanceProto.rarityWeights.set` = 8 (real), 0 (test content).
- `ItemCategory` gains **`"gem"`** (`ITEM_CATEGORIES` lists all ten).
- `ItemInstance` optional fields: `set` (SetItemProto id), `sockets` (gem base id or null per
  socket), `dur {cur, max}`, `upgrade` (0..5), `rerolls`, `tab` (stash tab while stashed).
- `ItemBaseProto` optional: `gem {kind, tier, weapon[], armor[], jewelry[]}`, `maxSockets`,
  `durability`. `NpcProto`: `gamble {categories}`, `crafts` (smith). `NpcRole` adds `"gambler"`
  (`classic.npc.mirelle`, "Mirelle Quickhand", art `unit.npc.gambler`, already in `npcs.ts`).
- `SkillProto.telegraph {ticks, shape: circle|cone|line, width?, count?}` (monster skills).
- `MonsterProto.phases [{atPct, message, skills, summon, enragePct}]`, `MonsterProto.guardian`.
- `SkillModifier {skill: id | "*" | "tag:<tag>", field: SkillModField, value}` with fields
  damagePct, manaCostPct, cooldownPct, speedPct, radiusPct, extraProjectiles, extraPierce,
  extraBounces, durationPct, extraSummons.
- `BalanceProto` optional: `talentPointsPerLevel` (1), `stashTabs` (4), `gemDrops` by monster
  rarity, `socketedDropPct` (8).
- `InteractableKind` adds `riftObelisk` (town) and `riftExit` (rift level, after the guardian).
  `core/intent.ts` (done): obelisk → emits `classic.rift.panel`; exit → `{op: "leaveRift"}`.
- `TransitionVia` adds `rift` and `riftExit`.
- `AutoConfig` optional: `autoRepair`, `autoCraft`, `autoGamble`, `autoRift` (all default true;
  `auto/actions.ts` CONFIG_FIELDS already accepts them).
- `RunStats` optional counters: `goldSpent` (every spender adds), `uniquesFound`,
  `setItemsFound`, `gambles` (items), `itemsCrafted`, `gemsSocketed` (crafting),
  `riftsCompleted` (rift). Increment as `rs.x = (rs.x ?? 0) + n`.
- `StashState.tabNames?`; capacity `rules.stashCapacity(bal)` = stashSize × stashTabs, per tab
  `stashSize`.

### 2.3 New components and resources

| Name                                                                                            | Shape                                                                                 | Owner                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Talents` (hero)                                                                                | `{points, spent, ranks[{node, rank}], levelSeen}`                                     | classic.talents                                                  |
| `BonusStats` (hero)                                                                             | `{sources[{source, mods[], skills[]}]}`                                               | each writer its own `source` entry via `bonus.ts setBonusSource` |
| `GroundEffect` (+ optional telegraph fields `once, shape, angle, arc, length, width, placedAt`) |                                                                                       | classic.combat                                                   |
| `RES.lootFilter` → `LootFilter`                                                                 | `{minRarity: Record<ItemCategory, rarity \| "none">, showGold, minGold, showPotions}` | classic.items                                                    |
| `RES.rift` → `RiftState`                                                                        | `{unlocked, maxCompleted, best, history[10], active: RiftRun \| null, nextRun}`       | classic.rift                                                     |
| `RES.achievements` → `AchievementState`                                                         | `{unlocked[{id, at}], title}`                                                         | classic.achievements                                             |

Readers: `lootFilterOf(w)` (default when missing), `riftOf(w)`, `achievementsOf(w)` (null when
missing).

### 2.4 Shared formulas (implemented in `rules.ts`, `bonus.ts`, `loot.ts`)

- Depths: `MAIN_DUNGEON_DEPTH = 16`; rift depths `riftDepth(level, run) = 100000 + 1000·level +
  run % 1000`, `isRiftDepth`, `riftLevelOf`; `monsterLevel(rift depth) = 18 + 2·level` (was 22; lowered after QA so level 1 is clearable); rift depths
  are never boss or waypoint depths; `tierOf(rift) = 3`.
- Items: `addItemStats` now adds smith upgrades (`upgradeMods`: weapon +6 % dmg/level, armor pieces
  +12 % base armor/level (min +level), jewelry +1 all attributes/level), socketed gems (`gemMods`
  by `socketGroup` weapon/armor/jewelry) and set bonuses of the list (`setBonusMods`, distinct
  pieces per set); broken items (`isBroken`: `dur.cur <= 0`) add nothing and
  `progression.stats` treats them as not equipped (no base damage/armor). Defaults:
  `maxDurabilityOf` (weapon 60, shield 60, armor 70, helm 50, gloves/boots 40, jewelry 0 =
  indestructible), `maxSocketsOf` (2H weapon 3, 1H 2, armor 3, shield/helm 2, gloves/boots/rings/
  amulet 1).
- Prices (EconomyProto): `repairCost`, `upgradeCost`, `rerollCost`, `socketCost`, `gamblePrice`,
  `talentResetCost`, `riftFee`; `riftScore(level, ticks, timeLimit, completed)` = level × 1000 +
  whole seconds left (0 over time; 0 when failed).
- Skill modifiers: `bonus.ts skillModsOf(world, registry, entity, skillId)` → `SkillModTotals`;
  `rules.effectiveManaCost`, `rules.effectiveCooldown`. The HUD skill bar already shows them.
- Stats: `progression.stats` adds `bonusMods(world, hero)` (all BonusStats mods) to the totals.
- Loot filter: `loot.ts itemVisible / lootVisible` (sets and uniques always visible).

### 2.5 Actions, commands, events, systems

All names are in `actions.ts` (`ACTION`, `ActionPayloads`, `ERR`, `HeroCommand`, `COMMAND_OWNER`),
`events.ts` (the "wave A" block) and `ids.ts` (`MODULE`, `SYSTEM`). Summary:

| Owner                | Actions (op)                                                                                                                                                                                                                                     | Systems (stage order)                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| classic.items        | `classic.gamble` (gamble), `classic.stashMove` (stashMove), `classic.stashPut` + optional `tab`, `classic.setLootFilter` (action only)                                                                                                           | `classic.items.wear` post 110                                         |
| classic.crafting     | `classic.repair` (repair, uid 0 = all), `classic.upgradeItem` (upgrade), `classic.rerollItem` (reroll), `classic.addSocket` (addSocket), `classic.socketGem` (socketGem), `classic.unsocketGems` (unsocket), `classic.combineGems` (combineGems) | `classic.crafting.commands` update 54                                 |
| classic.talents      | `classic.learnTalent` (learnTalent), `classic.resetTalents` (resetTalents)                                                                                                                                                                       | `classic.talents.points` pre 12, `classic.talents.commands` update 53 |
| classic.rift         | `classic.openRift` (openRift), `classic.leaveRift` (leaveRift)                                                                                                                                                                                   | `classic.rift.commands` update 55, `classic.rift.track` post 160      |
| classic.achievements | —                                                                                                                                                                                                                                                | `classic.achievements.check` post 900                                 |
| classic.debug (QA)   | `classic.debug.grant`                                                                                                                                                                                                                            | —                                                                     |

`grantItems` gains optional `category` (gambling, debug) and `minRarity: ItemRarity`.
Module skeletons exist (`src/{talents,crafting,rift,achievements,debug}/index.ts`) and are in
`modules` (debug only in `debugModules`).

---

## 3. Talents (T-talents; T-skills adds skills)

- One tree per class (`classic.talents.warrior|rogue|sorcerer`), 3 branches (columns) × 5 tiers
  (rows), 13–16 nodes, maxRank 1–5. Tier t needs `t × tierPoints` (3) points spent in the tree.
  `requires` links within a branch. Each class: at least 6 nodes with `SkillModifier`s on that
  class's skills (old and new, ids in §4), the rest stat passives (life %, crit, resists, attack
  speed, mana regen, potion %, magic find…). Plus one capstone per branch (tier 4, rank 1, strong).
- Points: `rules.talentPointsPerLevel` per level from level 2 (level 60 → 59 points); granted by
  `classic.talents.points` comparing `Level.level` with `Talents.levelSeen` (emits
  `classic.talent.points`). Talents component and `BonusStats` entry `"classic.talents"` (sum of
  `rank × perRank` per node, stats and skills) are created lazily.
- Auto/Idle (`config.autoAllocate`, mode ≠ manual): the same system spends every point on the first
  learnable entry of `TalentTreeProto.autoOrder` (so the auto controller needs nothing new).
- Reset: town only, `rules.talentResetCost` gold (sink, `RunStats.goldSpent`), refunds all points.
- UI: `TalentsPanel` (key N, button "Talents"): branch columns, tier rows, node buttons ≥ 44 px
  with rank pips, tooltip lines from `TalentNodeView.lines`, points header, reset button with price;
  `SkillsPanel` gets tabs "Skills | Talents" and shows new skills. Phone: one branch per page
  (segmented control).

## 4. New hero skills (T-skills, binding ids)

All use existing shapes (combat needs no new code for them). `fx` = `SkillProto.effect`;
projectile sprites use the same id as the effect.

| Id `classic.skill.*` | Name          | Class    | Lvl | Shape / numbers (guidance)                                          | fx                 |
| -------------------- | ------------- | -------- | --: | ------------------------------------------------------------------- | ------------------ |
| `quake_stomp`        | Quake Stomp   | Warrior  |  12 | nova r 2.5, 140 w% +8/r, stun 24 (50 %), mana 12, cd 100            | `fx.quake_stomp`   |
| `iron_skin`          | Iron Skin     | Warrior  |  15 | self buff `classic.status.iron_skin` (+armorPct, +resAll), cd 400   | `fx.iron_skin`     |
| `sky_leap`           | Sky Leap      | Warrior  |  18 | dash speed 180, max 7, 160 w% +10/r on arrival                      | `fx.sky_leap`      |
| `piercing_shot`      | Piercing Shot | Rogue    |  12 | projectile pierce 4, speed 110, 150 w% +8/r                         | `fx.piercing_shot` |
| `caltrops`           | Caltrop Field | Rogue    |  15 | aoeTarget r 2, 60 w% + `classic.status.chill` 40 % 80 ticks, cd 40  | `fx.caltrops`      |
| `night_volley`       | Night Volley  | Rogue    |  18 | projectile ×9 spread 2, 70 w% +4/r, cd 60                           | `fx.night_volley`  |
| `glacial_spike`      | Glacial Spike | Sorcerer |  12 | projectile pierce 2, cold 12–20 +3/+4, chill                        | `fx.glacial_spike` |
| `storm_call`         | Storm Call    | Sorcerer |  15 | aoeTarget r 2.5, lightning 18–40 +4/+8, cd 40                       | `fx.storm_call`    |
| `falling_star`       | Falling Star  | Sorcerer |  18 | aoeTarget r 2, fire 40–70 +8/+12, `classic.status.burn` 50 %, cd 80 | `fx.falling_star`  |

Classes list the new skills (`skills`, `autoSkillOrder`). **Rogue balance**: Rogue kills/min within
70 % of the Sorcerer's over 60 sim minutes (headless, seeds 2026/7/99) without raising Rogue deaths
above 3/h — tune Rogue skills, class numbers and `autoSkillOrder` (not the auto controller).

## 5. Itemization (T-items runtime, T-itemcontent data, T-items-hud UI)

### 5.1 Sets and uniques

- ≥ 6 sets (two per class themed, plus ≥ 1 generic), 3–5 pieces each, bonuses at 2/3/(4/5) pieces
  (stat mods). Set pieces drop with rarity "set" (weight above) when a `SetItemProto` with
  `ilvl ≤ item ilvl` exists (else rare). Name = piece name; mods rolled from the piece ranges.
- Uniques: 15 → ≥ 30, spread over every category and levels 1–40.
- `classic.set.bonus` when the equipped count crosses a bonus threshold (equip / unequip).

### 5.2 Gems and sockets

- 6 kinds × 5 tiers = 30 gem bases (`classic.item.gem_<kind>_<tier>`, names "Chipped / Flawed /
  Clear / Flawless / Radiant <Gem>"), size 1×1, icon `icon.item.gem`, ground art `loot.item.gem`.
  Ruby: weapon fire dmg, armor life, jewelry fire resist; sapphire: cold / mana / cold res; topaz:
  lightning / magic find / lightning res; emerald: poison / dex / poison res; amethyst: dmg % / armor /
  str; diamond: crit / all resist / all attrs (guidance; T-itemcontent tunes).
- Drops: `BalanceProto.gemDrops` chance by monster rarity; tier by monster level
  (`1 + floor(level / 10)`, max 5). Normal/magic weapons and armor drop with 1..max sockets at
  `socketedDropPct`.
- Smith (crafting): add socket (`EconomyProto.sockets.addCost[n]`), socket a bag gem into the first
  empty socket (free), remove all gems back to the bag (`unsocketCost`), combine 3 → 1 next tier
  (`combineCost[t-1]`).

### 5.3 Durability and repair

- Generated equipment gets `dur = {max, max}` (`maxDurabilityOf`); items without `dur` count as
  full and get one the first time they wear. `classic.items.wear` (post 110): every
  `EconomyProto.repair.everyKills` hero-credited kills the weapon and one `ctx.rng`-picked worn
  armor piece lose 1; a hero death costs every equipped item `deathLossPct` % of max. ≤ 10 % →
  `classic.item.worn` (once until repaired); 0 → `classic.item.broken` (no stats until repaired).
- Repair at the smith: `repairCost` per item, uid 0 = everything carried and worn.

### 5.4 Upgrade and reroll

- Upgrade L → L+1 (`maxLevel` 5): costs `upgradeCost`, succeeds with `chancePct[L]` (`ctx.rng`);
  failure spends the gold and keeps the item. The bonus is computed (`upgradeMods`), the item only
  stores `upgrade`. Name shows "+L".
- Reroll (magic, rare): new affixes of the same rarity and ilvl, `rerolls + 1`, price grows.

### 5.5 Gambler, stash tabs, loot filter

- Gambler (`classic.gamble {npc, category}`): price `gamblePrice`, rarity by
  `EconomyProto.gamble.weights`, base of that category with `ilvl ≤ hero level + 2`, ilvl = hero
  level; into the bag (fails before paying when nothing fits). `RunStats.gambles`, `goldSpent`.
- Stash: 4 tabs × 50; `stashPut {uid, tab?}` (first tab with room), `stashMove {uid, tab}`,
  `stashTake`. Offline / quest grants to the stash use the first tab with room.
- Loot filter: `classic.setLootFilter {filter: Partial<LootFilter>}` (strict validation; unknown
  keys and bad values rejected). Hidden loot: no ground label (client), never auto-picked
  (auto). Manual click still picks it up.

### 5.6 Item UI (T-items-hud)

Tooltip: set block (pieces worn ✓/✗, bonuses active/inactive), sockets row (gem glyphs + lines),
durability bar ("Broken" red), "+L" upgrade, filtered marker. Inventory: socket dots and a
durability tick on cells; gems stack visually by base. Vendor panel: smith shows "Smithing" (opens
`craft`), gambler opens `gamble`. Craft panel: item list (bag + equipped) with Repair / Upgrade
(chance %) / Reroll / Add socket / Socket gem / Remove gems, prices, disabled states with reasons;
gem section with Combine. Gamble panel: category cards with prices. Stash panel: tab strip with
counts. Loot filter panel: per-category minimum rarity (segmented), gold min, potions toggle, a
"hidden on ground: N" line.

---

## 6. Bosses and combat (T-bosses)

### 6.1 Telegraphs

When a monster casts a skill with `telegraph`, at `hitAt` combat does not hit. It spawns a
`GroundEffect` (Pos at the zone origin, `once: true`, `shape`, `angle`, `arc`, `length`, `width`,
`radius`, `nextAt = until = tick + ticks`, `placedAt = tick`, pre-rolled `damage`, `team`,
`owner`, `skill`, `effect`) and emits `classic.telegraph`. At `nextAt` `classic.combat.effects`
hits every enemy whose body overlaps the zone (circle: distance ≤ radius + body radius; cone:
within `length` and `angleDiff ≤ arc`; line: distance to the segment ≤ width/2 + body radius),
emits `classic.effect` with the skill's effect, and destroys the entity. A line telegraph also
dashes the caster along the line when it fires. `count` > 1 (circle aoeTarget): extra circles at
`ctx.rng` points within 3 tiles of the target. Telegraphs are cleared with their area.

### 6.2 Boss phases and content

- Phases (`MonsterProto.phases`): entered once each, in order, when life ≤ `atPct`; emit
  `classic.boss.phase`; `summon` → summon minions; `enragePct` > 0 → status
  `classic.status.enrage` (buff: +dmg %, +attack speed) for the rest of the fight; phase `skills`
  join the rotation. `Ai.count` keeps the phases done (replaces the 66/33 % summons).
- Rework the 4 bosses: each has 2–3 phases and at least 2 telegraphed skills; new boss skills
  (binding ids, `content/boss.ts`): `classic.mskill.boss_quake` (circle at target, 30 ticks),
  `boss_cleave` (cone, 24), `boss_rush` (line dash, 20), `boss_meteor` (3 circles, 36),
  `boss_frost_nova` (circle around the boss, 30); effects `fx.<same name>`; status
  `classic.status.enrage`.
- Rift guardians (`monsters.ts`, `guardian: true`, behaviour boss, `themes: []`):
  `classic.monster.guardian_maw` "The Gnashing Maw" (melee: quake, cleave, rush) and
  `classic.monster.guardian_choir` "Choir of Cinders" (caster: meteor, frost nova, volley), art
  `unit.monster.guardian_maw|guardian_choir`.
- Boss fights must stay winnable for Auto (it dodges telegraphs, §8) — measured in T-auto runs.

### 6.3 Skill modifiers in combat

Hero casts read `skillModsOf`: damagePct (all damage of the cast), manaCostPct and cooldownPct
(`effectiveManaCost/Cooldown` in orders), speedPct (added to the cast's speed stat), radiusPct
(nova, aoeTarget, pulse, self radius, arc reach), extraProjectiles, extraPierce, extraBounces,
durationPct (statuses, buffs, summons), extraSummons (count and max).

---

## 7. The Rift (T-rift)

- Main dungeon ends at depth 16 (no stairs down there). When `DungeonState.bossesKilled` contains
  `RiftProto.unlockBossDepth` (16), `RiftState.unlocked` (event `classic.rift.unlocked`). The town
  always has the **obelisk** (`riftObelisk` Interactable, prop `prop.rift.obelisk`, near the
  waypoint); before the unlock its panel says what unlocks it. The gambler NPC spot is placed by
  the existing NPC ring (no world change needed for her).
- `classic.openRift {target, level}`: town, obelisk in reach, unlocked, 1 ≤ level ≤
  maxCompleted + 1 (≤ RIFT_MAX_LEVEL), fee `riftFee` paid (`goldSpent`), `run = nextRun++`,
  `active = RiftRun`, transition `{to: riftDepth(level, run), via: "rift"}`. Entering a rift
  destroys the live dungeon level like any other depth change (the portal closes).
- World for rift depths (`generateArea`): `RiftProto.size`² map, rooms/packs from RiftProto, theme
  `themes[level % n]`, no stairs, no waypoint, population at `monsterLevel(depth)` with the normal
  champion/unique rules (no ramp), exploration as usual; arrival at the first room. Never update
  `deepest` or waypoints for rift depths.
- `classic.rift.track` (post 160): progress += `RiftProto.progress[rarity]` per hero-credited
  death in the rift (cap `goal`; `classic.rift.progress` every 10 %); at the goal spawn the
  guardian (`guardians[level % n]`, rarity boss, level `monsterLevel` (was +2 before the wave A QA pass), near the hero on a free
  tile ≥ 6 tiles away; `classic.rift.guardian`). Guardian dead → completed: record
  (`riftScore`), rewards (gold `goldPerLevel × level`, `items + floor(level / bonusEvery)` items
  `minRarity` at monster level via grantItems; half when over time), `riftExit` Interactable at
  the guardian, `maxCompleted`, `best`, `history`, `RunStats.riftsCompleted`,
  `classic.rift.completed`. Hero death in a rift or `leaveRift` before completion → failed
  (`reason` "death" / "left", score 0, `classic.rift.failed`), `active = null`. `leaveRift` /
  the exit → transition `{to: 0, via: "riftExit"}`. Town portal scrolls are disabled in a rift
  (`ERR.inRift`).
- Leaderboard-ready: `RiftRecord` holds level, ticks, score, deaths, completed, reason, hero level,
  class, name, worldSeed, endTick, run. Deterministic: the same seed and inputs give the same
  records. Wave B submits completed records for server replay and stores them in D1.
- UI: `RiftPanel` — locked state; level picker (fee, monster level, affordable), Open button; best
  and last runs table; while in a rift: progress bar, timer, guardian state, Leave. A small HUD
  progress bar while in a rift lives in the panel only (T-hud may add a widget later).

## 8. Auto and Idle (T-auto)

- Fix §0.1 #1: no `fight` plan with an idle intent for more than 40 ticks; descend reliably (the
  stairs location is known when the level is entered; explore frontiers are biased toward the
  stairs once `explorePct` is near; quest/restock trips are not taken while descending if the stairs
  are within ~30 tiles; fights while leaving stay close). Targets: headless Idle seed 4242 (and 7,
  2026), every class reaches depth ≥ 3 by tick 12 000 and depth ≥ 5 by tick 36 000; browser
  `classic-idle <class> 5 8` shows ≥ 2 descents (counted from samples / area events); x8 runs at
  ≥ 100 sim ticks per wall second in the headless QA browser or the report explains the
  bottleneck with measurements (fix in `loop.ts`; anything elsewhere goes in the report).
- New systems in the town routine (`todo` steps, each skipped when not applicable): `repair`
  (autoRepair; any worn item < 60 % or broken), `craft` (autoCraft; socket gems into the best
  equipped items, add sockets, upgrade the weapon/armor while gold > reserve), `gamble`
  (autoGamble; rings/amulets with gold above a reserve that scales with level), stash into tabs
  (tab 0 general, 1 sets/uniques, 2 gems, 3 overflow — a convention, not a rule). Loot pickup
  honours `itemVisible`. Gems are always picked up.
- Rift: when `autoRift` and unlocked and the main dungeon is finished (deepest = 16, boss dead):
  run rifts at the highest level whose last attempt completed under the time limit, else one
  lower; open via the obelisk; leave via the exit; repeat.
- Telegraph dodging: a hero inside a live monster telegraph (`GroundEffect.once`, team monster)
  steps out (nearest walkable tile outside the zone) before it fires, before anything else except
  potions.
- Gold sinks balance: over 60 sim minutes every class ends with ≤ 35 % of the gold it earned
  (`RunStats.goldSpent / goldEarned`), measured headless (tune `economy.ts` prices and the auto
  spending policy).
- Talent points are spent by classic.talents itself; Auto needs nothing for them.

## 9. Achievements (T-achievements)

≥ 30 achievements over every `AchievementMetric` (several tiers per metric: e.g. kills 100 / 1 000
/ 10 000). Metrics are read from the world every 20 ticks: RunStats fields (and the optional
counters), `Level.level`, `DungeonState.deepest`, `QuestState.completed.length`, `Talents.spent`,
`RiftState.maxCompleted` (riftLevel), `setComplete` (1 when every piece of any set is equipped),
`playMinutes` = `RunStats.ticksPlayed / 1200`. Unlocks are sorted by id, gold via `grantGold`
(reason "achievement"), `classic.achievement.unlocked`. Panel: progress bars, unlocked first,
hidden ones as "???", titles (display only, stored client-side).

## 10. Client presentation

### 10.1 Effects and art (T-art, T-render, T-client)

- Art ids (T-art makes them, T-render plays them, T-client's gallery shows them):
  - `fx.<name>.burst` one-shot animations (centre anchor, 64 px = 1 tile of radius, 6–10 frames)
    for **every** id in `EFFECT_TABLE` (`effects.ts`) plus the new ones: `fx.quake_stomp`,
    `fx.iron_skin`, `fx.sky_leap`, `fx.piercing_shot`, `fx.caltrops`, `fx.night_volley`,
    `fx.glacial_spike`, `fx.storm_call`, `fx.falling_star`, `fx.boss_quake`, `fx.boss_cleave`,
    `fx.boss_rush`, `fx.boss_meteor`, `fx.boss_frost_nova`, `fx.telegraph`; projectile stills
    `fx.piercing_shot`, `fx.night_volley`, `fx.glacial_spike` (pointing right).
  - Particle textures `fx.particle.<style>` for the 10 `ParticleStyle`s (Kenney Particle Pack CC0
    and/or procedural).
  - Units: `.cast.<facing>` and `.hit.<facing>` clips for every unit (generated poses: squash,
    recoil, flash, glow) so the gallery resolves them `exact`; distinct silhouettes for the three
    classes and six NPCs (layered gear/robes/hoods/beards/weapons, palettes); new
    `unit.npc.gambler`, `unit.monster.guardian_maw`, `unit.monster.guardian_choir`.
  - Props: `prop.rift.obelisk`; `fx.rift.exit` (animated portal, distinct from `fx.portal`);
    loot `loot.item.gem`. Atlas pages stay ≤ 2048² and total atlas PNG bytes grow ≤ 20 %.
- Renderer (contract `render.ts`): `EffectKind` adds `telegraph`, `aura`, `burst`;
  `EffectSpec.angle/arc/length/width/style/intensity`; `${sprite}.burst` animations; a pooled
  particle system; `ArpgRenderEntity.castGlow/glowColor/hitFlashColor` (white additive hit flash);
  `setQuality(low|medium|high)`; `shake(strength, ms)`. No per-frame allocations; caps per quality.
- Client (`effects.ts`): every new event gets visuals (table below); `EFFECT_TABLE` rows for the
  new effect ids with a `style`; telegraph duration scales with the sim speed; scene: set loot
  green, gem loot, loot-filter-hidden loot gets no label, `castGlow` while casting.

| Event                                  | Visual                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `classic.telegraph`                    | `telegraph` effect (shape, fills for `ticks × 50 / speed` ms)                                       |
| `classic.boss.phase`                   | toast (message), log, `shake(6, 400)`                                                               |
| `classic.item.broken` / `worn`         | log red / amber; broken also an error flash                                                         |
| `classic.gambled`, `classic.set.bonus` | log; toast for set/unique gamble and for set bonuses                                                |
| crafting events                        | log + float at the hero ("+3!", "Upgrade failed", "Repaired")                                       |
| `classic.talent.points`                | toast "Talent point (N)" (first time per level)                                                     |
| rift events                            | toasts for opened/guardian/completed (score)/failed; log for progress; `rift.panel` opens the panel |
| `classic.achievement.unlocked`         | toast with the reward                                                                               |
| `classic.npc.opened` role gambler      | open `gamble` panel                                                                                 |

### 10.2 Audio (T-audio)

`src/client/audio/index.ts` contract (`createAudio`, `ClassicAudio.onEvents/applySettings/
unlock/destroy`) is wired in `game.ts`. WebAudio synthesis only (oscillators, noise buffers,
filters, envelopes): hits by element, crits, misses, deaths by rarity, casts per skill family,
projectiles, telegraph warning, boss phase sting, loot drop by rarity, gold, potion, level up,
quest, UI clicks (via events), rift, achievement. Voice cap (≤ 12) and per-sound rate limits that
tighten at x4/x8. Ambient music: generative per area theme (town, crypt, caves, forge, abyss, rift;
slow chords + drones + sparse melody), crossfade on area change, ducked during boss fights.
Settings: master / sfx / music volume, mute. Never throws; silent without WebAudio.

### 10.3 HUD (T-hud and the panel owners)

- Toasts never cover panels or their buttons (move toasts to a lane that panels avoid, or offset
  them below open panels); desktop and 390 px.
- New panel buttons / keys: Talents (N), Achievements (Y); Settings: audio sliders, mute, graphics
  quality (auto/low/medium/high), tips toggle + "reset tips", "Loot filter…" (opens lootFilter).
  Phone: the bottom bar collapses rarely used buttons into a "More" menu (≥ 44 px targets).
- Character panel: stats with sources (items / talents / sets / buffs), resistances, DPS per bar
  skill (`DpsView`), effective life, title.
- Onboarding tips (`src/client/tips/**` + a widget): one tip at a time, non-blocking, dismissible,
  remembered in localStorage `gamez.classic.tips.v1`; triggers: welcome/Auto, first skill point,
  first talent point, first town visit (smith/gambler/stash), first worn item, first set/unique,
  bag full, first boss, rift unlocked, Idle speed. Off with Settings.tips.

### 10.4 Graphics quality

`Settings.quality` (auto|low|medium|high) → `game.ts applyQuality` → `renderer.setQuality`. Auto
= medium on coarse pointers or < 700 px, else high (T-client may refine with an fps probe).

## 11. QA and debug

### 11.1 Cheats (T-client)

`?debug=1&cheats=1` loads `debugModules` with a mode variant (different contentHash; local saves
never mix). `classic.debug.grant` payload (validated): `{gold?, levels?, items?: {count, rarity,
ilvl, category?}, gems?: number, unlockRift?: boolean, bossesKilled?: number[], deepest?: number,
talentPoints?: number}`. `window.__gamez.controls.cheat(payload)` wraps it. Without `cheats=1`
the action does not exist.

### 11.2 QA harness (T-client)

New scenario `classic-features [class]` (cheats): opens talents, learns a node, smith (repair,
upgrade, socket), gambler, stash tabs, loot filter, rift (open level 1, progress, guardian via
cheats or by fighting, completion record), achievements, settings (audio, quality); screenshots
of each at desktop and `--viewport phone`. `classic-idle` reports `data.descents`. Gallery shows
every new effect, unit (cast/hit), prop.

### 11.3 Save carry-over (T-client, dev convenience)

When the stored save's contentHash differs but its module ids are a subset of the current ones,
try restoring the snapshot under the new contentHash, step 20 ticks in a try/catch; on success
keep it (toast "Save carried over"), else start fresh. `?fresh=1` skips it. Lazy resource creation
(§1.1 rule 3) is what makes this safe. Local only; the server never trusts it.

## 12. Test plan

| Area          | Tests (owner)                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every module  | behaviour; determinism (same seed + script → same hash); a pinned hash; rejections (`ok: false`, hash unchanged) for every new action (all owners)                                                     |
| Talents       | points per level, tier/requires gating, BonusStats sums, auto allocation order, reset cost and refund, skill modifiers visible in stats (T-talents)                                                    |
| Combat/bosses | telegraph placement/fire/miss when dodged, cone/line geometry, phases once each, enrage, skill modifiers (all fields), boss fight won by a scripted hero (T-bosses)                                    |
| Items         | set rolls + bonuses thresholds, gem drops/tiers, sockets/combine, wear and broken stats, repair costs, upgrade chance (seeded), reroll, gamble, stash tabs, loot filter validation (T-items)           |
| Rift          | unlock, open (fee, level bounds), map size/no stairs, progress, guardian, completion rewards and record, failure on death/leave, score formula, deterministic records (T-rift)                         |
| Auto          | descent regression (seeds 4242/7/2026), no idle-fight stalls, town routine uses repair/craft/gamble/stash tabs/filter, telegraph dodge, rift loop, hoarding ≤ 35 %, 60-min autoplay per class (T-auto) |
| Content       | ids/references resolve (skills ↔ classes ↔ talents, set pieces ↔ bases, gems tiers chain, guardians ↔ rift) (T-skills, T-itemcontent, T-talents, T-bosses)                                             |
| Client        | effects for every new event, telegraph timing at speeds, hotkey target ignores hero summons, cheats gated, carry-over restore, audio never throws (fake AudioContext), HUD layouts at 1366 and 390 px  |
| Browser QA    | QA focuses (workflow) with `tools/qa`; gallery coverage: no `procedural`-only skill effect, cast/hit `exact` for heroes and monsters                                                                   |

Gates for the wave (final fixer): `vp check`, `vp run -r test`, `vp -C apps/game build`,
`vp run e2e`, QA focuses — all green, plus the measured numbers recorded in §14.

## 13. Decisions

- **Set as a rarity** (not a flag on uniques): tooltips, colours, filters and drop weights all key
  on rarity already.
- **Upgrades are computed** from `ItemInstance.upgrade` in `rules.upgradeMods` (rerolls never wipe
  them; one formula for HUD, auto and stats).
- **BonusStats by source** instead of talents writing CombatStats: progression keeps one stats
  pipeline; future sources (sets with skill mods, runes, cosmetics) plug in the same way.
- **Telegraphs are GroundEffects**: they live in the world (snapshots, replays), the client draws
  them from an event, and the auto controller reads them like any entity.
- **Rift depths are synthetic depths** (≥ 100 000): maps stay a pure function of (worldSeed,
  depth), every run gets a fresh map, monster level is derivable from the depth.
- **Durability wears by kills and deaths**, not by hits: deterministic, cheap (Bus.deaths), and it
  scales the repair sink with play time.
- **Main dungeon capped at 16**: the Rift replaces endless depth scaling with a scored ladder.
- **Prices in one EconomyProto** owned by the balancing task (T-auto), read through rules helpers.

## 14. As built (filled in by the integrator)

Integrated 2026-10-28 on top of 72d61b1. Decisions are in [ADR 0004](../adr/0004-classic-wave-a.md).

### 14.1 Gates

| Gate                                    | Result                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp check`                              | 0 errors, 0 warnings (491 files)                                                                                                                                                                                     |
| `vp run -r test`                        | all green. classic: 67 files and 1 174 tests (was 669 at the contract commit). apps/game: 30 files and 285 tests. The workspace has about 1 770 tests.                                                               |
| `vp -C apps/game build`                 | green. Main chunk 1.19 MB (368 kB gzip). The existing > 500 kB chunk warning remains.                                                                                                                                |
| `vp run e2e`                            | all checks pass. New section 7 crawls the client module graph: 325 modules, 0 failures, and it includes the classic view and the talents, crafting, rift, achievements and audio modules.                            |
| QA `classic-idle <class> 2 8`           | warrior: 2 descents, 260 slain, 0 deaths. rogue: 2 descents, 283 slain, 0 deaths. sorcerer: 3 descents, 231 slain, 0 deaths. Each run covers about 13–14 k ticks, and all heroes reach levels 5–6. 0 console errors. |
| QA `classic-features` (desktop + phone) | 19 checks each, all pass. The only warning: a cheat hero at level 11 dies in rift level 1 (monster level 24) before reaching the guardian, which is expected.                                                        |
| QA `gallery`                            | 429 cells, all `exact`, no art problems, no action fallbacks                                                                                                                                                         |

Pins updated by the integrator, for content and version changes only:

- `content.test.ts` registry: `d8e9ca1488245478` → `e4c38ef5d5b6f4c0`.
- `core.test.ts` fixed script: `0e5f17e22a604318` → `06e0cf325772af36`. This is the contentHash change from the classic.combat 0.3.0 and classic.monsters 0.3.0 bumps; T-bosses checked that the old versions reproduce the old pin.
- The mode contentHash is now `7866b66f16b335ee`.

### 14.2 Content

- **Skills and talents:** 24 hero skills (15 + 9) and 3 talent trees of 15 nodes each.
- **Items:** 8 sets with 32 pieces, 32 uniques (15 + 17), 92 item bases including 30 gems (6 kinds × 5 tiers), and 107 affix rows.
- **Monsters:** 18 monsters. The four act bosses now have 2–3 phases and telegraphed skills, and there are 2 rift guardians.
- **Other:** 49 achievements over all 21 metrics, plus one economy and one rift prototype.
- **Art:**
  - 6 atlas pages, each ≤ 2048².
  - Atlas PNG bytes grew from 18.9 MB to 21.7 MB, +14.7 % (budget 20 %).

### 14.3 Measured numbers

**Idle descent and gold** (headless, 9 runs, T-auto). Columns: depth / level / kills / deaths at 20 and at 60 sim minutes; gold kept after 60 minutes.

| Class    | 60 min depth | 60 min level | Gold kept (60 min) | Depth 3 at tick | Depth 5 at tick |
| -------- | ------------ | ------------ | ------------------ | --------------- | --------------- |
| rogue    | 8–9          | 14–15        | −2 % to 16 %       | 10 222 – 16 738 | 30 902 – 37 283 |
| sorcerer | 11           | 18           | 2 % to 4 %         | 9 329 – 12 385  | 17 216 – 24 348 |
| warrior  | 6–8          | 12–14        | −4 % to 4 %        | 9 138 – 23 566  | 48 448 – 63 725 |

Against the targets:

- **Depth ≥ 3 by tick 12 000:** met in 4 of 9 runs.
- **Depth ≥ 5 by tick 36 000:** met by the sorcerer (3 of 3) and the rogue (2 of 3). The warrior misses it in all 3 runs: its kill speed is the limit, not the controller.
- **Gold kept ≤ 35 %:** met everywhere. Before wave A the sorcerer kept 45–70 %.
- **No idle fight stall:** the longest stretch the hero could act but stood idle was 6 ticks over 9 × 72 000 ticks; the limit is 40.

**Browser Idle x8** (headless software GL, after stopping 16 orphaned QA browsers left by earlier runs): 105–115 ticks/s average, 79–145 per sample, so the target of ≥ 100 is met.

- Before the fix: about 22 ticks/s.
- With the orphaned browsers still running: 62–74 ticks/s.
- The fix was the renderer and loop frame clamp raised to 1000 ms, plus the `loop.observe` budget.

**Rogue balance** (T-skills; 60 min, seeds 2026/7/99):

- **Kill rate:** 16.5 kills/min, 80 % of the sorcerer's 20.6. Target met (≥ 70 %).
- **Deaths:** 3.3 per hour, against a target of ≤ 3. Not met, but still the lowest of the three classes: sorcerer 6.7, warrior 7.0.

**Bosses** (T-bosses; seed 11, a hero one level above each boss who dodges telegraphs). Every phase is entered, and the hero never goes more than 11 ticks without acting.

| Boss             | Fight time | Hero deaths |
| ---------------- | ---------- | ----------- |
| Warden           | 103 s      | 1           |
| Tunnel Mother    | 173 s      | 2           |
| Ninth Flame      | 194 s      | 4           |
| Hollow King      | 484 s      | 8           |
| Gnashing Maw     | 295 s      | 7           |
| Choir of Cinders | 200 s      | 2           |

**Telegraph dodging** (sorcerer, seed 2026, 22 000 ticks): 26 telegraphs, 26 dodges, 0 hits.

**Achievements:** rewards total 24 005 gold, about 2.0 % of the estimated 1.18 M gold that kills alone bring by level 60.

### 14.4 Integration fixes

- **Gambler panel:** the gamble panel was always empty. `game.ts` now passes the open gambler into `buildHud`, and opening the vendor or the gambler clears the other.
- **Frame budget:** `game.ts` calls `loop.observe` after every step, enabling the 40 ms budget. `FRAME_DELTA_MAX_MS` went from 250 to 1000.
- **Talent-point toast:** it now shows only points still unspent after the step. Before, Auto spent the point in the same step and the toast still asked you to spend it.
- **Rift depth labels:** rift depths are shown as "Rift level N" in the area banner, the area toasts and the level-cleared lines (`depthLabel`), instead of "Depth 101,001".
- **Desktop bottom bar:** the XP row now fills its own line, so the life orb no longer wraps up beside it.

### 14.5 Known gaps (next waves)

- **Warrior pace:** the warrior misses the depth-5 target, and the 4-slot Auto bar never adds the new level 12–18 skills for the warrior and sorcerer. A bar-swap rule is needed.
- **Rift labels:** the obelisk is placed one tile from the smith, so their labels overlap in town.
- **Rift goal:** now 100 progress with 18–26 packs (was 120 with 22–30); revisit it with real clear rates.
- **Cheat heroes in the rift:** a cheat-built hero (levels and ilvl-22 rares only, no stat points spent) still dies in rift level 1; a hero that killed the Hollow King (level 26, 17 400 life) faces a level-20 guardian (Choir of Cinders: 9 775 life).
- **Combat:** monster skills set their element through a local combat rule (weaponPct plus an all-zero `damage` block). A `SkillProto.element` field would be cleaner. `boss_slam` and `boss_nova` are no longer used by any boss.
- **Contract:** `ItemView` has no gem tier field; the HUD reads the tier from the gem's name.

### 14.6 Browser QA fix pass

Fixes for the wave A browser QA findings (lenses combat-visuals, wave-a-panels, late-game-loop):

- **Rift balance:** rift level L has monster level 18 + 2L (was 22 + 2L), so level 1 (20) sits below depth 16 (23). Packs 18–26 (was 22–30), goal 100 (was 120), and the guardian spawns at the rift's monster level (was +2). In a headless probe (cheat level-24 hero with ilvl-22 rares, seed 77, one run per class), the warrior and the sorcerer reached the guardian and then died to it, and the rogue reached 69 % before a champion killed it. Before the change, QA runs reached 0 % to 44 % and never saw the guardian. No class completed level 1 with cheat gear.
- **Rift deaths:** a death inside a rift costs no gold (the fee was the stake). XP loss stays. The toast names only what was lost ("Lost 2 XP", "Nothing was lost").
- **Auto rifts:** Auto opens a rift only when level 1's monsters are within 2 levels of the hero (`riftReady`), and it pauses after two level-1 failures in a row until the hero gains a level. It farms the main dungeon instead of paying fees to die.
- **QA routes (`classic.debug`):** `set` (every piece of a set), `riftProgress` (fills the open run, so 100 calls the guardian), `spawnBoss` (a boss or guardian awake beside the hero) and `woundBosses` (phases on demand). `render.shakes` counts camera shakes. The new QA scenario `classic-boss` captures circle, cone and line telegraphs, both phases, the phase toast and the shake. `classic-features` checks the 2-piece set bonus and the guardian path.
- **Touch inventory:** a tap on a bag item opens the item sheet, which shows the full tooltip body (`ItemDetails`) plus the actions. A second tap on the same item equips it. Mouse clicks still equip at once.
- **Layout:** desktop panels are 97 % opaque. On desktop, the error flash moves into the toast column while a panel is open. Damage table headers keep a gap and never wrap. Phone attribute rows have 8 px between their + buttons. In the gallery, bosses and rift guardians have their own two-row section.
