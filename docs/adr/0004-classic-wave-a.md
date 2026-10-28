# ADR 0004: Classic wave A, single-player depth that stays local

- Status: accepted (wave A)
- Date: 2026-10-28

Wave A turns Classic into a deep single-player idle ARPG. It adds talents, nine skills, sets, gems, sockets, durability, smith crafting, a gambler, stash tabs, a loot filter, telegraphed boss phases, the Rift, achievements, procedural audio, quality settings, tips and a DPS panel. The design and its binding ids are in [`docs/design/wave-A.md`](../design/wave-A.md); §14 of that file has the measured numbers. This ADR records the decisions that later waves build on.

## 1. The sim still runs only in the browser

Wave A changes no DO, protocol message, migration or D1 projection. Classic saves to `localStorage`. Everything that makes server verification possible in wave B is still true:

- All the new code is kernel modules (`classic.talents`, `classic.crafting`, `classic.rift`, `classic.achievements`), plus changes to existing ones.
- It is deterministic under the AGENTS.md §6 lint.
- It is pinned by hash tests.

The QA cheat module `classic.debug` is only in `debugModules`, so it never enters `MODULE_CATALOG` or the server contentHash.

New state is created lazily, the first time a system or op needs it, so old saves and partial module sets keep loading. That rule (wave-A.md §1.1 rule 3) is what lets a save carry over a content change locally (§11.3). The server will never trust a carried-over save.

## 2. Rift depths are synthetic depths

A rift level is the depth `100000 + 1000·level + run % 1000` (`rules.riftDepth`):

- Maps stay a pure function of (worldSeed, depth).
- Every run gets a fresh map.
- The monster level is derived from the depth (22 + 2·level).
- The main dungeon ends at depth 16. Rifts are never waypoint or boss depths, and they never update `deepest`.

A finished run is a `RiftRecord`: level, ticks, score = level × 1000 + whole seconds left, deaths, class, worldSeed, endTick and run. That is everything a wave B replay needs to verify the record before it goes into a D1 `leaderboard_rift` projection. The client shows these depths as "Rift level N" (`depthLabel`), never as the raw number.

## 3. One stats pipeline, bonuses by source

Talents, sets, gems and smith upgrades never write `CombatStats` directly:

- Talents write a `BonusStats` source entry with stat mods and skill modifiers.
- Items carry `upgrade`, `sockets` and `set`.
- `progression.stats` sums them all through `rules.addItemStats` and `bonusMods`.

Broken items count as unequipped. Skill modifiers (damage, cost, cooldown, speed, radius, projectiles, pierce, bounces, duration, summons) are read in combat through `skillModsOf`. Monsters have no `BonusStats` and take the cheap path.

Future bonus sources, such as runes and cosmetics, plug into the same pipeline.

## 4. Telegraphs are world entities

A telegraphed monster skill places `GroundEffect`s with shape, angle, arc, length and width, and they fire once at `nextAt`. They are ordinary entities: they appear in snapshots, a replay reproduces them, and the auto controller dodges them by reading the world. The client draws them from the `classic.telegraph` event, with the fill time scaled by the sim speed. Damage is rolled when the telegraph is placed, so it does not depend on whether the caster is still alive when it fires.

## 5. Gold sinks live in one prototype

Repair, upgrade, reroll, sockets, gambling, talent reset and rift fees all come from `EconomyProto` (`classic.economy`) through `rules` price helpers. One balancing owner tunes them, and the HUD, Auto and the ops read the same numbers. Durability wears by kills and deaths, not by hits: it is deterministic, cheap, and makes the repair sink scale with play time.

Measured result: over 60 headless sim minutes on Idle, every class keeps between −4 % and 16 % of the gold it earned. The target was ≤ 35 %; before wave A the Sorcerer kept 45–70 %.

## 6. The client frame budget

QA major #1c: the browser ran Idle x8 at about 22 ticks/s. There were two causes:

- **Clamped frame deltas.** The renderer clamped each frame at 250 ms and dropped the rest, so slow frames lost sim time.
- **Load from other processes.** Orphaned headless QA browsers were running the game at x8 in the background.

Changes:

- The renderer frame delta (`FRAME_DELTA_MAX_MS`) and the classic `FixedLoop` now both accept frames of up to 1000 ms and keep a bounded backlog.
- `game.ts` feeds the measured tick cost to `loop.observe`, which caps sim work at 40 ms per frame. A slow device therefore runs the sim slower instead of producing ever longer frames.

Measured on the headless software-GL browser, Idle x8: 80–145 ticks/s per sample, about 110 on average. Before wave A it was about 22, and about 62–74 with the orphaned browsers still running.

## Consequences and follow-ups

- **Wave B** wires classic into `CharacterDO` / `InstanceDO`:
  - persistence and replay verification;
  - `RiftRecord` submission and the D1 leaderboard projection;
  - account-wide achievements.
- **e2e:** it now also crawls the client module graph. Classic has no server path yet, so this check is the only one that would catch a module failing to transform in dev.
- **Balance gaps:**
  - The Warrior reaches depth 5 only at 48–64 k ticks; the target was 36 k.
  - The Rogue dies 3.3 times per hour; the target was ≤ 3.
  - The 4-slot Auto bar never picks up the new level 12–18 Warrior and Sorcerer skills.
