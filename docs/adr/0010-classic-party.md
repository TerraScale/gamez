# ADR 0010: Classic party system

- Status: accepted (party system)
- Date: 2026-10-28

The classic mode gets a **party**. One player runs up to four heroes in the same deterministic
sim. Every hero plays on the party AI, and the player can take control of any one of them at any
time. The design, task split and contracts are in [`docs/design/party.md`](../design/party.md).
This ADR records the decisions later work builds on and the numbers behind them.

## 1. A party of one is the solo game, bit for bit

`RES.party` (`PartyState`) is **absent** until the first party action (recruit, buySlot, config,
control, rename, reorder, give). Every reader goes through `party/shared.ts`, which falls back to
`[GameState.hero]`. `ensureParty()` is the lazy migration: founder = the hero, `PartyMember{uid:0}`
seeded from `RunStats`. Systems never call it.

- Old local saves, server snapshots and offline progress need **no format change**. A content-hash
  change (the version bumps below) goes through the existing wave A carry-over on the client and
  `VerifiedHost #carry` on the server. Both relabel the stored base because its module ids are a
  subset of the loaded ones (`classic.party` is new and creates its state lazily).
- Every per-member rule (scaling, XP split, extra loot rolls, threat, think throttling) is gated
  on 2+ members, and size 1 takes the old code path without touching the RNG.
- **Proof:** during the whole build every pre-existing pinned hash stayed green without a re-pin.
  The integrator then bumped the touched modules once and re-pinned (§8).

## 2. The controlled hero is `GameState.hero`; followers always run the AI

`heroOf()` is the controlled hero: manual actions, the HUD snapshot, the camera and
`ControlState.mode` apply to it, so every panel switches with control for free. Every other member
is a follower and runs the follower brain (`SYSTEM.autoParty`, pre 5) in any control mode.
"Party: Auto" is `mode !== "manual"`: the controlled hero then runs the leader brain. The acting
leader is the controlled hero while it stands, otherwise the first standing member.

- Control is a kernel action (`classic.party.control`), so the server replays it like any input.
  The client binds portrait clicks, F1–F4 and Tab / Shift+Tab (Tab stays the automap when solo;
  the backquote key always opens it).
- In auto/idle with `autoSwitch`, a downed controlled hero hands control to the acting leader.

## 3. One purse, per-hero sheets

`Wallet` and `Supplies` exist **only on the founder**, who can never be dismissed. Every gold and
scroll read or write goes through `purseOf()` / `partyGold()`. The stash, quests, waypoints,
dungeon progress, rift and achievements are shared. Class, level and XP, attributes, skills,
talents, equipment, bag, belt and `AutoState` are per hero. Dismissing a hero moves its gear into
the stash.

## 4. The party is always in one area

Invariant I2: every member's `AreaTag.depth` equals the area depth. Every transition (stairs,
waypoint, portal, town portal, rift, respawn) moves every member: the acting leader lands on the
arrival point and the followers on formation spots. Downed members come along and stay down.
Inside an area the `regroup` op (owner classic.world) teleports a follower that is stuck, or
farther than `leashTeleport` (24 tiles), next to the leader. The leader's waits are bounded
(100 ticks for stragglers, 600 for followers' town errands, 400 for a revive before going to
town). The result is no area split and no deadlock:

- The 40 000-tick soak (`party.idle.test.ts`, 4 heroes on Idle) keeps every follower within the
  leash on 100 % of samples.
- The 20-minute acceptance run (`party.autoplay.test.ts`, warrior, rogue, sorcerer and rogue on
  Idle) gives 579 kills, levels 9/9/9/9, XP for every hero, depth 4, 13 town trips together,
  0 ticks with a member outside the party's area, and leash 100/100/100/100 %.

## 5. Commands and events carry `hero` only for followers

`HeroCommand = Body & {hero?}` and `ClassicEvent = Body & {hero?}`. Producers set `hero` **only for
followers** (and events only while a party exists), because leftover commands and the events of a
segment are part of the solo state and stream. Owners resolve the actor with `commandHero()`, and
a non-member fails with `not_member`. Ops take an explicit hero (`execX(world, ctx, hero, …)`).
New ops are `revive` and `give` (classic.party) and `regroup` (classic.world).

## 6. `World.peek()`: read-only access without a rollback copy

The kernel's undo log copies a live value the first time `get()`/`read()` hands it out in a
transaction (ADR 0003 update). With 300 monsters and 4 heroes, those copies were the largest single
cost of a tick: `copyStored` took 26 % of the 4-hero scenario. The kernel now has
`world.peek(e, C)`. It returns the same value with no log entry, and the result must never be
mutated (`update()` after a `peek()` is fine, because `update()` logs its own copy).

- The hot read-only paths use it: monster think and acquisition, wake, the spatial rebuild, the
  movement index and the Mover read (a unit's Mover, with its path, is only taken live when the
  unit changes it), orders, casting, resolve, damage rolls, projectiles, `scanFoes` and the hero
  stats input. `progression/util.put` skips merges that would not change anything.
- No state or hash changed: every pinned hash stayed green before the version bumps.
- Measured on the dev box in plain node with one `sim.step(1)` per tick:

  | Scenario (300 awake monsters, ~190 in melee)       | Before  | After   |
  | -------------------------------------------------- | ------- | ------- |
  | core + combat + monsters + world, 1 hero           | 2.43 ms | 1.24 ms |
  | core + combat + monsters + world, 4 heroes         | 3.26 ms | 1.78 ms |
  | every module, 4 heroes on Idle (healed, sustained) | 4.4 ms  | 2.6 ms  |

## 7. Balance and performance

Monsters scale at spawn, for monster-team spawns in a party of 2+ only (`PartyProto`, data that
modules can patch):

| Party size                        |   1 |   2 |   3 |   4 |
| --------------------------------- | --: | --: | --: | --: |
| monster life %                    | 100 | 160 | 220 | 280 |
| monster damage %                  | 100 | 110 | 120 | 130 |
| monster xp % (the kill's XP pool) | 100 | 140 | 175 | 210 |
| each member's share of a kill (%) | 100 |  65 |  54 |  48 |
| loot % (item rolls, gold)         | 100 | 140 | 175 | 210 |
| density % (monsters per pack)     | 100 | 110 | 120 | 130 |

- The member share started at 75/62/55. The balance test (four level-matched heroes on Auto,
  depth 1–4, 15 minutes, two seeds) measured 1.815x solo XP per hero, above the 1.8x cap. With
  65/54/48 it measures 1.64x XP per hero and 1.43x kills per minute, both inside their bands, with
  no more deaths than solo ([`docs/bench/2026-10-party.md`](../bench/2026-10-party.md)).
- Slots 2/3/4 unlock for free at the depth 4/8/12 bosses, or for 1 500 / 7 500 / 30 000 gold.
  A recruit starts at the highest member level − 3 and costs 50 gold per level. Both are sinks.
- A member death in a party is "downed": it costs that member's XP share, and gold is lost only
  on a wipe. A standing ally revives it by channelling 60 ticks within 1.5 tiles (35 % life), and
  the town revives downed members. A wipe is the solo respawn.
- **Performance (budget amended, see party.md §12).** The core sim (core, combat, monsters and
  world) meets the 2 ms budget with 4 heroes and 300 awake monsters (1.78 ms). With every module
  the target is relative: the party's worst case within 1.25× the solo worst case (solo itself
  is about 2.3 ms there), and normal 4-hero Idle under 2 ms. QA's 2.75–3.7 ms readings were
  taken at load average 27; at load 9 the bench gives 2.42 ms solo and 2.60 ms for 4 heroes. With every module and a sustained 300-monster melee
  it measures about 2.3 ms for the best 25-tick window and 2.6 ms mean. Of that, the party AI is
  about 0.5 ms (leader 0.2–0.3 ms, three followers 0.25 ms). Normal Idle play with 4 heroes costs
  about 1.1 ms per tick. Monster think is throttled to every 2 ticks in a party of 2+
  (`PARTY_THINK_EVERY`). Flow fields are memoised per targeted member, and followers re-plan every
  8 ticks, staggered by slot.
- **Update (ADR 0013, 2026-10-30):** the sim hot path work cut the every-module melee tick by
  21–27 % with identical hashes; the old idle-box 2.3 ms best window and 2.6 ms mean scale to
  about 1.7–1.8 ms and 1.9–2.05 ms ([`docs/bench/2026-10-sim-perf.md`](../bench/2026-10-sim-perf.md)).
- Timing asserts in tests now scale with the measured machine load (`tests/support/perf.ts`,
  a fixed reference workload versus its idle time), because the full suite saturates every core:
  a bare 6 ms bound flaked, and anything looser caught nothing.

## 8. Versions

The touched modules were bumped once:

- core 0.4.0, world 0.4.0, combat 0.4.0, monsters 0.4.0
- items 1.3.0, progression 0.4.0, auto 0.4.1 (0.4.0, then 0.4.1 for the mid-fight revive
  give-up, `lead.ts reviveRetreat`; with the version unchanged every pinned hash stayed green,
  so only the content hash moved)
- talents 1.1.0, crafting 1.1.0, rift 1.1.0, achievements 0.2.0
- platform 1.1.0, party 1.0.0, debug 0.4.0

Every pinned hash that moved was re-pinned. Persisted instances carry over, because the module ids
are unchanged.

## 9. Server, leaderboards and presence

- Party actions are ordinary kernel actions, so `VerifiedHost` replays them and `serverOnly` is
  unchanged. A tampered control input (a non-member) gets `input_rejected`.
- Reports write one `classic_hero` row per member: key `"hero"` for the founder (old rows stay)
  and `"hero:<uid>"` for the others. The D1 schema is unchanged. The season total uses the
  founder's level, so it stays monotonic.
- The town shows the whole party: `PoseUpdate.companions` (at most 3, offsets −4..4, sanitised by
  the ChunkDO; binary flag bits) are drawn as `"ally"` units next to the remote avatar.
- e2e (`tools/e2e/src/classic-party.ts`):
  - An imported save buys two slots, recruits two heroes, renames one and switches control.
  - It plays 960 ticks of party Idle x8, every segment verified.
  - A tampered control input resyncs.
  - D1 gets the rows `hero`, `hero:1` and `hero:2`.
  - After the dev-server restart the party and the controlled hero resume.

## Consequences

- New code that acts for "the hero" must take the hero explicitly and use `purseOf()` for gold.
- New per-member rules must keep size 1 on the solo path. The pinned solo hashes are the guard.
- Hot read-only loops should use `peek()`. Mutating a peeked value is a rollback bug that tests
  will not catch.
- Online co-op (several players in one party) stays out of scope. `instance.maxPlayers` is still 1.
