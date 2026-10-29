# Classic party system — design

Status: **implemented** (integrated on branch `party-system`, base 420da97). Decisions and measured numbers: [ADR 0007](../adr/0007-classic-party.md).
Package: `@gamez/mode-classic` (`modules/classic`). Read first: `AGENTS.md`, `docs/design/classic.md`,
`wave-A.md`, `wave-B.md`, `wave-C.md`, `packages/kernel/README.md`.

The classic mode gets a **party**: up to four heroes, each with its own class, level, stats,
skills, talents, equipment, bag and potion belt, playing **at the same time in the same sim**.
Every hero runs on the Auto/Idle AI by default. The player can take control of any one hero at
any moment (portrait click, F1–F4, Tab), and that hero gets manual input, the full HUD and the
camera. The others keep playing on the party AI.

All names are original. No new art is needed: party members use the class appearances and the
existing identity outline (`ArpgRenderEntity.highlight`, commit 420da97).

---

## 0. Goals and non-goals

Goals:

1. Up to 4 heroes in one deterministic sim, verified by the server like the solo game.
2. A party of one is **bit-identical** to the solo game. Old saves, server snapshots, offline
   progress and every pinned hash keep working, and migration is lazy (§9).
3. A party AI that never deadlocks or splits for good. It uses formation, focus fire, protection,
   roles, heals and buffs, revives and coordinated travel. Party wipes respawn in town.
4. Control switching with full HUD fidelity for the controlled hero, plus party frames for all.
5. Balance: a party is stronger, but monsters scale with party size, so it is never trivial.
   Performance: 4 heroes plus 300 monsters must stay under 2 ms per tick.

Non-goals (§16): multiplayer parties of different players, PvP, a recruiter NPC, new class art,
shared bag, per-hero gold.

---

## 1. Vocabulary

| Term            | Meaning                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| member          | A hero entity in `PartyState.members` (solo: `GameState.hero`)                                                                                |
| controlled hero | `GameState.hero` (`heroOf`). Manual actions, HUD, camera and `ControlState.mode` apply to it                                                  |
| follower        | Every member except the controlled hero. Always driven by the party AI                                                                        |
| acting leader   | The controlled hero while it stands, otherwise the first standing member in slot order (`actingLeaderOf`)                                     |
| downed          | A member with `Dead` while another member still stands. It waits for a revive or town                                                         |
| wipe            | Every member is down. The solo death flow takes over (respawn in town)                                                                        |
| founder         | The save's first hero. It can never be dismissed. It holds the **purse** (shared `Wallet` + `Supplies`) and owns the `"hero"` leaderboard row |
| slot            | Position in `members` (0..3). Sets frame order and hotkeys F1..F4                                                                             |

---

## 2. Data model

### 2.1 Resource `classic.party` (`RES.party`, `PartyState`, owner `classic.party`)

```ts
interface PartyState {
  members: Entity[]; // slot order, 1..4; always contains GameState.hero and founder
  founder: Entity; // never dismissed; holds the purse
  slotsBought: number; // 0..3
  nextUid: number; // next PartyMember.uid (founder 0)
  config: PartyConfig; // formation, spread, focusFire, revive, autoSwitch
}
```

**The resource is absent until the first party action** (recruit, buySlot, config, control,
rename, reorder). A world without it is a party of one. Every reader goes through
`party/shared.ts`, which falls back to `[GameState.hero]`. `ensureParty(world, ctx)` creates it
(founder = hero, `PartyMember{uid:0}` seeded with the solo `RunStats.kills/deaths`). Only party
**actions** call it, never systems, so a solo game never writes party state.

### 2.2 Components

| Component                                                         | On                    | Shared or per hero                                                   |
| ----------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Hero, Level, Attributes, SkillBook, SkillBar, Talents, BonusStats | every member          | per hero                                                             |
| Life, Mana, CombatStats, HeroStats, Statuses                      | every member          | per hero                                                             |
| Pos, AreaTag, Mover, Body, Faction("hero"), Intent, AutoState     | every member          | per hero (AutoState is created lazily for followers by classic.auto) |
| Inventory, Equipment, Belt                                        | every member          | per hero                                                             |
| **Wallet, Supplies**                                              | **founder only**      | **shared purse**: read and write through `purseOf()` / `partyGold()` |
| PartyMember {uid, joinedTick, role, kills, deaths}                | members (party only)  | per hero; leaderboard and frame data                                 |
| Reviving {target, startedAt, until}                               | a reviver, while busy | per hero                                                             |

Shared resources: stash (`RES.stash`), quests, dungeon, explore, rift, achievements, run stats,
control, vendors and loot filter. **Gold, town portal scrolls, stash, quests, waypoints and
progress are shared. Everything a character sheet shows is per hero.**

### 2.3 Invariants

- I1: `GameState.hero ∈ members` and `founder ∈ members` while the party exists.
- I2: every member's `AreaTag.depth === AreaState.depth`. The party is always in one area.
  Transitions move every member (§6.6), so the party **cannot split across areas**.
- I3: `members.length <= slots <= PartyProto.maxMembers` (4).
- I4: only the founder has `Wallet` and `Supplies`. `items.heroInit` gives a new hero those
  only when there is no party or it is the founder.
- I5: no system iterates members in any order other than slot order (`partyMembers()`), so
  the order is deterministic.

### 2.4 Helpers (`src/party/shared.ts`, implemented)

`partyOf, partyMembers, partySize, isPartyHero, memberSlot, isDowned, aliveMembers, followersOf,
isFollower, actingLeaderOf, partyWiped, leaderMode, founderOf, purseOf, partyGold, commandHero,
partyScaleOf, slotsOf, roleOf, ensureParty`. Pure rules live in `rules.ts`:
`DEFAULT_PARTY_PROTO, partyProtoOf, partyScale, partyKillXp, bossSlots, partySlots,
nextSlotPrice, recruitLevel, recruitFee, facingVec, FORMATION_SPOTS, formationOffsets`.

---

## 3. Control model

- `GameState.hero` is the **controlled hero**. `classic.party.control {hero}` changes it, and so
  does the party auto-switch (§7.3). Changing it resets `ControlState.overrideUntil` to 0 and
  emits `classic.party.control`.
- `ControlState.mode` (manual / auto / idle) applies to the controlled hero only. **Followers
  always run the party AI**, whatever the mode.
- "Party: Auto" is `mode !== "manual"`. The controlled hero then runs the leader brain, and the
  camera, which always follows the controlled hero, follows the leader. Full Idle drives the
  whole party, using speed ×1–×8 as before.
- `leaderMode(world, tick)`:
  - `"off"`: the player leads, either in manual mode or in auto with a manual override running.
    It is also `"off"` when the whole party is down.
  - `"full"`: the leader brain.
  - `"defend"`: manual mode, the controlled hero is down and someone still stands. The acting
    leader fights nearby foes and revives, but never explores or travels.

---

## 4. Actions and commands

### 4.1 Actions (module `classic.party`; payloads in `actions.ts ActionPayloads`)

| Action                  | Payload           | Rules (ActionError code)                                                                                                                                                           |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic.party.recruit` | `{classId, name}` | phase play (`no_hero`), town (`not_in_town`), known class (`unknown_id`), `cleanHeroName` (`bad_payload`), free unlocked slot (`party_full`), fee ≤ purse gold (`no_gold`)         |
| `classic.party.dismiss` | `{hero}`          | member (`not_member`), not the founder (`founder`), town (`not_in_town`), its equipped and bag items fit the shared stash (`stash_full`)                                           |
| `classic.party.rename`  | `{hero, name}`    | member, clean name                                                                                                                                                                 |
| `classic.party.reorder` | `{order}`         | an exact permutation of the members (`bad_order`)                                                                                                                                  |
| `classic.party.control` | `{hero}`          | member (alive or downed). No-op error `bad_target` if it is already controlled                                                                                                     |
| `classic.party.config`  | `{config}`        | `Partial<PartyConfig>`, strict keys and types (`bad_payload`). Spread is an integer 1..4                                                                                           |
| `classic.party.buySlot` | `{}`              | town, a locked slot left (`party_full`), price `nextSlotPrice` ≤ purse gold (`no_gold`). `slotsBought = slots` (the new total minus one). Emits `classic.party.slots {via:"gold"}` |
| `classic.party.give`    | `{uid, to}`       | `uid` is in the controlled hero's bag (`unknown_id`), `to` is another member (`not_member`) with room (`bag_full`)                                                                 |

Every apply calls `ensureParty()` first. Manual actions of other modules still act for the
**controlled hero** (`heroOf`), and every manual action keeps calling `noteManual`.

**Recruit flow.**

1. Compute the start level `recruitLevel(proto, highest member level)` and the fee
   `recruitFee(proto, level)`, and take the fee from the purse.
2. Call `spawnHeroEntity(world, ctx, cls, classId, name)` (progression/hero.ts, extracted
   from `execNewHero`).
3. If the start level is above 1, call `addXp(world, ctx, e, xpAtLevel(level), "recruit")`.
   The recruit gets the normal level-up points, and talent points come from the talents
   system's `levelSeen` rule.
4. Place it on the nearest free walkable town tile next to the controlled hero (`Pos`,
   `AreaTag(0)`).
5. Add `PartyMember{uid: nextUid++, role: roleOf}` and append it to `members`.
6. Emit `classic.party.recruited`.

`items.heroInit` gives it the class starter kit on the next tick, but no purse.

**Dismiss flow.**

1. Move every equipped and bag item into the stash (first tab with room). Belt potions are lost.
2. Destroy its summons, remove it from `members` and destroy the entity.
3. If it was controlled, control passes to `members[0]`
   (`classic.party.control {reason:"dismiss"}`).

### 4.2 Hero commands (`Bus.commands`)

`HeroCommand = HeroCommandBody & { hero?: Entity }`. When `hero` is absent, the command acts for
the controlled hero, so solo producers are unchanged. Owners resolve the actor with
`commandHero(world, cmd)`, and a non-member fails with `not_member`. **Producers set `hero`
only for followers.** Leftover commands are part of the snapshot, so setting it for the
controlled hero would break bit-identity.

New ops:

- `revive {target}` (owner classic.party). Starts a `Reviving` channel when the acting hero
  stands, is not busy, and `target` is a downed member within `reviveRange`.
- `give {uid, to}` (owner classic.party). The auto gear distributor's version of the action.
- `regroup {}` (owner classic.world). Places the follower (`hero`) on a free walkable tile next
  to the acting leader. This is the party AI's leash teleport.

`classic.interact {target}` on a **downed member** walks there and pushes `revive` (core.intent).
The client picks it as `PickKind "ally"`.

### 4.3 Ops take the hero

Every `execX(world, ctx, …)` that acts for "the hero" gets an explicit `hero: Entity`. Actions
pass `heroOf(world)`, command systems pass `commandHero(world, cmd)`, and gold goes through
`purseOf(world)`. Travel ops (stairs, waypoint, portal, town portal, rift) may be issued by any
standing member that is in reach. They move the **whole party** (§6.6).

---

## 5. Events

`ClassicEvent = ClassicEventBody & { hero?: Entity }`. Every per-hero event carries `hero`: xp,
levelUp, statAllocated, skillLearned, hero.died, hero.respawned, loot.picked, gold, potion,
item._, bag.full, vendor._, talent.*, set.bonus and the smith events. Observers treat a missing
`hero` as the controlled hero.

New events (`classic.party.*`): `recruited`, `dismissed`, `renamed`, `reordered`,
`control {hero, previous, reason}`, `config`, `slots {slots, via, cost}`, `downed`,
`reviving {hero, by, until}`, `reviveCancelled`, `revived {hero, by, via: ally|town|respawn}`,
`wiped`, `itemGiven`. Audio has a table entry for every one of them (`client/audio/cues.ts`).

---

## 6. Party AI (classic.auto)

Two brains share `AutoCtx` (per hero) and the existing helpers (fight, dodge, potions, town
routine). Both now take the hero as a parameter instead of reading `heroOf`.

### 6.1 Leader brain (`SYSTEM.autoThink`, pre 0)

It runs for `actingLeaderOf(world)` when `leaderMode` is `"full"`, and as "defend" (only fight,
dodge, potions and revive) when `leaderMode` is `"defend"`. It is the solo controller, with these
changes:

- **Town trips consider the whole party.** The party goes to town when any member has a full
  bag, no life potions while below its retreat %, broken gear, or the leader's own reasons.
- **The town routine runs for every member.** Each follower runs its own todo (heal, sell,
  repair, buy potions, stash, craft, gamble) with its own `AutoState`, using the purse. The
  leader's `"return"` step waits until every standing follower's todo is empty and the
  followers are within 4 tiles. It waits at most 600 ticks, then goes anyway.
- **Never descend or take stairs while a member is downed**, unless it is a town trip:
  revive first. If no revive succeeds within 400 ticks, go to town, which revives them.
- **The retreat check uses the party.** Leave when the leader is low, or when two or more
  members are below `retreatPct` with no potions.

### 6.2 Follower brain (`SYSTEM.autoParty`, pre 5)

It runs for every standing follower in slot order, in any control mode. A full re-plan
happens every 8 ticks, staggered by slot (`(tick + slot) % 8`). Cheap reactions (dodge,
potion) run every tick. In priority order:

1. **Dodge** telegraphs (existing `dodge.ts`) and **drink** potions (per-hero thresholds from
   `AutoConfig`).
2. **Leash.** Beyond `leashTeleport` from the acting leader, or stuck for 60 ticks while more
   than 6 tiles away, push `regroup`. Beyond `leashRange`, drop everything and walk to the
   formation spot.
3. **Heal.** If an ally is below 50 % life and the follower knows a heal (Mend, `allyRadius`),
   walk within radius and cast.
4. **Fight** (§6.4) while a foe is within the **assist radius** (8 tiles of the acting leader
   or 5 of itself), or is attacking any member.
5. **Revive.** With `config.revive`, a downed member, and no awake foe within 6 tiles of it,
   walk to it and push `revive`. The nearest standing follower does this, one reviver per
   target.
6. **Loot.** With no foe near, pick up loot within 4 tiles of itself that passes the loot
   filter and `AutoConfig.pickupRarity`, without straying more than `spread + 3` tiles from
   its spot.
7. **Follow.** Walk to the formation spot when it is more than 1 tile away. The repath is
   throttled to every 10 ticks or when the leader moves by more than 2 tiles. Otherwise idle.

Followers **never travel on their own** and never open portals. The leader's travel takes
them along (I2).

### 6.3 Formation and roles

`formationOffsets(formation, spread, leaderFacing, roles)` gives integer tile offsets.
"front" members (Warrior) take the most forward spots, and "back" members (Rogue, Sorcerer)
the rear spots. The spot is the nearest walkable tile to leader + offset, which avoids walls,
using a small spiral search. Formations: `wedge` (default), `line`, `ring`. While fighting,
back-line members keep their skill range (existing kite logic), and front-line members engage
in melee.

### 6.4 Targeting

1. If `focusFire` is on and the leader's target (Intent target or `AutoState.focus`) is a live
   foe within the assist radius, use it.
2. Otherwise, protect: pick the foe whose `Ai.target` is the member with the lowest life %
   below 60 %.
3. Otherwise, the nearest foe to the follower within the assist radius.
4. Sticky: keep the current target while it lives and is in the assist radius, unless rule 1
   or 2 picks a different one.

### 6.5 Heals and buffs

There is no friendly fire: hero-team hits never target hero-team units (combat check, tested).
Buff skills already apply to hero-team allies in their radius. **Mend** gets
`heal.allyRadius = 5 tiles` (party content patch), and combat heals every standing hero-team
unit in that radius. The AI casts buffs when allies are in radius, using the existing
`minTargets` counting allies.

### 6.6 Travel together

Every transition (stairs, waypoint, portal, town portal, rift, respawn, new) moves **every
member**:

- The acting leader, or the controlled hero if no one stands, lands on the arrival point as
  today.
- Followers land on their formation spots around it, on free walkable tiles.
- Downed members come along and stay down.
- `leaveArea` destroys the summons of every member.

### 6.7 Deadlock and split prevention

- I2 makes area splits impossible.
- The leash `regroup` bounds the distance inside an area.
- The leader's waits are bounded (600 ticks for followers' town todos, 400 ticks for revives),
  and the existing kill and stall watchdogs stay.
- A wipe falls back to the solo respawn (auto respawns in auto/idle).
- Test: a 4-hero Idle run of 40 000 ticks must meet all of these:
  - every follower is within `leashTeleport` of the leader at least 99 % of the time;
  - no follower is more than 6 tiles away for over 300 consecutive ticks outside fights;
  - depth progresses;
  - no exceptions.

### 6.8 Gear, points and offline

- **Gear distribution** (`auto/gear.ts`, town and after pickups). For each bag item of each
  member, compute the upgrade score for every member who can use it. If the best member is
  not the holder and its score is above 0, push `give` from the holder to the best member,
  then `equip` for that member. Ties go to the lower slot. Items nobody wants follow the solo
  keep, sell or stash rules.
- **Points.** Stat, skill and talent points are auto-allocated for every follower, and for the
  controlled hero only in auto/idle (the existing rule).
- **Offline progress** (`auto/offline.ts`):
  - Kills and items are computed for the acting leader's strength, then scaled by
    `partyScale(size)`: kills × (party kill rate), XP split per living member with
    `partyKillXp`.
  - Gold goes to the purse, and items go to the stash first, then to the founder's bag.
  - `classic.offline.summary` keeps its shape (party totals).

---

## 7. Multi-hero sim rules (per module)

### 7.1 core / combat / monsters / world

- Intent execution, movement, regen, stats and exploration run for **every member** in slot
  order.
- Monster targeting picks the nearest **standing** member within aggro. It is sticky while the
  current target stands, and switches when another member is at least 3 tiles closer or hits
  the monster. Each target hero gets its own flow field (`heroFieldOf`, memoised per hero
  tile, only for heroes that are targeted). Wake checks use any standing member.
- Downed heroes are not targets, not solid, and have no collisions. They keep their position.
- `isHeroSide` means any member or a summon of any member. `DeathRecord.isHero` is true for
  any member. `classic.hit.heroHit` is true when the target is a member, and `byHero` when the
  source is hero-side.
- **Monster scaling** at spawn, for monster-team spawns only:
  - Life is scaled by `lifePct`.
  - Damage is scaled by `damagePct`: `dmgMin`, `dmgMax` and the flat element adds.
  - `Monster.xp` is scaled by `xpPct`.
  - Pack sizes are scaled by `densityPct` (world populate; rounded down, at least the solo
    count).
  - Size 1 skips all of it, so there are no RNG or state differences.

### 7.2 progression

- **XP.** For each credited kill, every standing member in the area gets
  `partyKillXp(bal, proto, size, ownLevel, monsterLevel, Monster.xp)`. Life and mana on kill,
  and `PartyMember.kills`, go to the killer hero (or the summon's owner). Quests advance once
  per kill.
- **Death** (`heroDeath`, per member on `Dead.at === tick`):
  - The member loses its XP share and its intent goes idle.
  - `PartyMember.deaths` and `RunStats.deaths` go up by one.
  - **Gold is lost only when this death wipes the party** (and never in a rift).
  - In a party of two or more, a non-wipe death emits `classic.party.downed`, and a wipe emits
    `classic.party.wiped` (both from classic.party).
- **Respawn** (op/action, allowed while the controlled hero is down): revives **every** downed
  member at full life and mana and pushes the town transition for the party.
- **Healer.** The healer NPC heals every member.

### 7.3 classic.party systems

- `partyCommands` (update 56): `revive` and `give`.
- `partyRevive` (post 610):
  - It advances `Reviving`. The channel is cancelled when the reviver moves (`Mover.moving`),
    casts, is hit (any `classic.hit` this tick on it, via `Bus.hits` before resolve, or a life
    drop), dies, or the target is no longer downed or in range.
  - At `until` it removes `Dead`, sets life and mana to `reviveLifePct`, makes the hero solid
    again with an idle intent, and emits `revived {via:"ally"}`.
  - When the area is the town, every downed member is revived at full life next to the
    acting leader (`via:"town"`).
  - It emits `downed` and `wiped` on the tick of the death.
- `partyControl` (post 620). In auto/idle with `config.autoSwitch`, if the controlled hero is
  downed and someone stands, control moves to `actingLeaderOf`
  (`classic.party.control {reason:"death"}`).

All three return at once for solo or a party of one.

### 7.4 items, talents, crafting, rift, achievements, platform

- **items:**
  - `heroInit` runs for every new hero (purse only for solo or the founder, I4).
  - Pickup and buy act for the commanding hero, and gold always goes to or comes from the
    purse.
  - Drops are scaled by `lootPct`: the number of item rolls (fractional part rolled once with
    the same RNG call order) and the gold pile size. Size 1 does not touch the RNG.
  - Wear: kill wear applies to the killer hero, death wear to the dying member.
- **talents and crafting:** per-hero ops. Gold comes from the purse.
- **rift:**
  - Fees come from the purse.
  - The run fails on a **wipe** (reason `"death"`). Member deaths count in `RiftRun.deaths`.
  - `RiftRecord` hero fields describe the acting leader at the end. The optional
    `party?: {name, classId, level}[]` lists the members.
- **achievements:** metrics use the highest member level and party-wide counters.
- **platform:**
  - Reports have one `classic_hero` row per member: key `"hero"` for the founder, which keeps
    old rows, and `"hero:<uid>"` for the others. Rows use `PartyMember.kills/deaths` when they
    exist. A dismissed hero's row stays as its last record.
  - The season total uses the **founder's** level, so it stays monotonic.
  - The arena build uses the controlled hero.
  - Bank gold moves to and from the purse, and items come from the controlled hero's bag.

---

## 8. Balance

`PartyProto` (`rules.DEFAULT_PARTY_PROTO`, defined by classic.party, tunable by data):

| Party size                        |   1 |   2 |   3 |   4 |
| --------------------------------- | --: | --: | --: | --: |
| monster life %                    | 100 | 160 | 220 | 280 |
| monster damage %                  | 100 | 110 | 120 | 130 |
| monster xp % (the kill's XP pool) | 100 | 140 | 175 | 210 |
| each member's share of a kill (%) | 100 |  65 |  54 |  48 |
| loot % (item rolls, gold)         | 100 | 140 | 175 | 210 |
| density % (monsters per pack)     | 100 | 110 | 120 | 130 |

Rationale:

- Four heroes have about 3.5–4× the damage of one (followers are slightly worse players).
  Monsters with 2.8× life die about 1.3–1.4× as fast.
- Each member gets 2.10 × 0.48 = 1.01× a solo kill's XP per kill. With the party's faster kill
  rate that measures 1.64× a solo hero's XP rate (the first proposal, 75/62/55, measured 1.815×,
  above the 1.8× cap). Parties level a little faster per hero, but not 4×.
- Loot rises with mouths to feed. Density adds danger and kills without growing the tick
  budget much.
- `tests/party.balance.test.ts` (T-auto) checks the target band with real content:
  - Four level-matched heroes on Auto clear depth 1–4 with kills per minute of 1.2–2.5× solo.
  - Deaths per hour stay at or below solo.
  - XP per hero per minute is 0.8–1.8× solo.

**Slots:**

- Slot 2 unlocks at the depth-4 boss (Morrow), slot 3 at the depth-8 boss, slot 4 at the
  depth-12 boss.
- Each can be bought early for 1 500, 7 500 or 30 000 gold. This is a gold sink.

**Recruits:**

- A recruit starts at the highest member level − 3, with level-up points.
- The fee is 50 gold × the start level (the sink). It wears starter gear, and gear
  distribution and the stash catch it up.
- Economy: no new faucet besides higher loot%, which matches the larger party. The new sinks
  are recruit fees and slot prices.

---

## 9. Saves, snapshots and offline progress

- **Lazy migration.** Old saves have no `RES.party` and no `PartyMember`, which is exactly
  the solo state. Nothing runs until the player's first party action, and `ensureParty`
  converts then (§2.1).
- **Local save** (`client/persist.ts`). A content hash change triggers the existing wave A
  carry-over. Stored module ids ⊂ loaded ids (`classic.party` is new and creates its state
  lazily), so the save is relabelled and validated for 20 ticks. No format change.
- **Server** (`VerifiedHost #carry`). Same rule: the stored base is relabelled and validated,
  and the log is re-applied. Party actions are ordinary kernel actions, so segments replay
  them. `MAX_INPUTS_PER_SEGMENT` (256) is plenty.
- **Offline progress** (§6.8) is server-only as before. Eligibility is unchanged (the
  controlled hero is not in manual).
- **Tests** (T-platform):
  - A solo snapshot without party state restores under the party build and accepts a recruit.
  - A party snapshot round-trips (save → restore → same hash after N ticks).
  - VerifiedHost replays a segment with recruit, control, give and travel inputs to the client
    hash.
  - Offline grants on a party split XP per member.

---

## 10. Client

### 10.1 HUD model

`HudSnapshot.party: PartyView` (`client/model/party.ts`, every 100 ms) holds the members
(portrait appearance, class, level, XP ‰, life, mana, role, downed, reviving %, controlled,
leader, founder, plan, unspent points, up to 4 statuses), slots, slot prices and boss, recruit
level, fee and blocker, config, gold, `inTown` and `partyAuto`. Everything else in the snapshot
(hero, orbs, skill bar, belt, bag, equipment, skills, talents, craft, dps) describes the
**controlled hero**, so switching control switches every panel for free.

### 10.2 Party frames (`widgets/PartyFrames.tsx`, slot `classic.hud.left`, order 5)

- Show it with 2 or more members. With one member, show a small "+ Party" button once a second
  slot is unlocked.
- Each frame has a portrait, name, level, life and mana bars, a downed skull or revive
  progress, the role glyph, an unspent-points badge and the hotkey label.
- The controlled frame has a gold border (matching the "self" outline) and the others cyan.
- Click or tap a frame to call `act("classic.party.control", {hero})`.
- The header shows the "Party: Auto" toggle (`classic.setControl` auto ↔ manual) and opens
  the panel.
- Desktop: a vertical stack at the top left above the quest tracker, 200 × 48 px per frame.
- Compact (< 700 px): 44 × 44 portraits with thin bars in wrapping rows (the Party button first)
  at the top of the bottom-anchored left column, so it never climbs into the control bar. Touch
  targets are at least 44 px. It must work at 375 px width.

### 10.3 Party panel (`panels/PartyPanel.tsx`, key **P**)

- Roster: rename (inline), reorder (up and down buttons), dismiss (confirm; "gear goes to the
  stash"), and take control.
- Recruit uses the NewHeroScreen pieces (class cards plus name), with the start level, fee and
  blocked reason.
- Slots: unlocked/total, the next boss or "Buy for N gold".
- AI options: formation, spread, focus fire, revive, auto-switch.

### 10.4 Input (`client/input.ts`, `client/game.ts`)

- **F1–F4**: take control of slot 1–4.
- **Tab** / **Shift+Tab**: cycle control forward and back when the party has 2 or more
  members. With one member, Tab keeps the automap. The **`** key (Backquote) always toggles
  the automap.
- **P**: party panel.
- Space still cycles Manual → Auto → Idle for the controlled hero.
- Pointer: a tap on a downed member (`PickKind "ally"`) is an interact, which revives.
  Standing members are not picks.

### 10.5 Minimap and feedback

- `MinimapData.party` holds the other members' positions. They are drawn as cyan dots
  (hollow when downed). The controlled hero keeps the existing marker.
- Toasts, log and level-up fanfares get full feedback for the controlled hero. Other members
  get compact log lines and toasts ("Brannoc-the-2nd reached level 9", downed, revived,
  recruited).
- Floating XP and gold numbers show for the controlled hero only. Damage numbers show for
  everyone.
- **DeathScreen:**
  - With a party standing, the overlay is replaced by a slim banner: "<Name> is down – F2
    takes control · revive by clicking them · Respawn party in town".
  - On a wipe, it shows the solo death screen ("Your party has fallen").

### 10.6 Rendering (`client/scene.ts`)

- Every member is drawn. The controlled hero gets `highlight: "self"` (gold, the "Outline my
  hero" setting) and `isSelf`, and the others get `highlight: "party"` (cyan).
- Name plates show for all members (`showLabel`).
- Downed members use the dead pose and a pick `"ally"`.
- Summons owned by any member get `highlight: "party"` (port of the `party-ink-alt` ownership
  idea onto the highlight system). Remote players in town keep `"ally"` (green).
- The camera follows the controlled hero and pans smoothly on switch: `follow()`, not `snap`,
  unless more than 12 tiles away.
- Effects and audio: hero-hurt sounds for any member, quieter for followers. Level-up and loot
  fanfares only for the controlled hero. Party cues are in the audio table.

---

## 11. Server

### 11.1 Verification

Party actions are kernel actions, so `VerifiedHost` replays them unchanged. `serverOnlyActions`
is unchanged. The policy's `speedOf` and `offline.eligible` read ControlState and GameState,
both of which are unchanged.

### 11.2 Leaderboards

See §7.4: one `classic_hero` row per member, keyed `"hero"` (founder) and `"hero:<uid>"`. The
D1 schema does not change.

### 11.3 Presence (classic town)

- `PoseUpdate.companions?: CompanionPose[]` (`@gamez/protocol`, at most 3) holds appearance,
  name and the integer tile offset −4..4 from the avatar. `EntityState.companions` mirrors the
  last sanitised list. The JSON and binary codecs carry it (binary: pose flag bit 2 and entity
  flag bit 1, a count byte, then entries).
- The ChunkDO sanitises it (`apps/game/src/server/presence/pose.ts`) and stores it on the
  avatar. Offsets are clamped, bad appearances dropped, names cut to 24 characters, and the
  list capped at 3.
- The client reports the followers' tile offsets relative to the controlled hero. It draws
  remote companions as `p:<id>:c<i>` with `highlight: "ally"` at the remote avatar's
  interpolated position plus the offset.

---

## 12. Performance plan

Budget: **4 heroes + 300 monsters ≤ 2 ms mean per tick** on the dev box. Assertions allow 3×
for load, because the shared box runs other workflows. Measure with
`tools/bench` / `tests/party.perf.test.ts`.

- Kernel `world.peek()` (ADR 0007 §6): hot read-only loops take no rollback copy. This halved
  the tick for solo and party alike.
- Monster think: picking a target scans at most 4 members (no allocation). Flow fields are
  computed only for targeted heroes and memoised per (hero tile).
- Followers: a full re-plan every 8 ticks, staggered. Per-tick work is O(1) checks.
  Neighbourhood scans use the spatial grid. Path requests are throttled per follower.
- Stats recompute is per member every tick, as today for one hero (cost × 4, about 0.05 ms).
  If it shows up in the bench, recompute on change (equipment, level, statuses) with a dirty
  flag.
- Client: the frame model is rebuilt at 10 Hz with structural sharing. Party frames read
  through `useSelect` selectors. The scene upserts members only when they change.

---

## 13. Test plan (summary; every task lists its own)

| Area     | Tests                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contract | `tests/party.contract.test.ts` (architect): rules, shared helpers, lazy migration, content patches                                                                                    |
| core     | per-member intent and movement, monster targeting and switching, no friendly fire, Mend heals allies, travel moves the party in formation, regroup, explore, scaling, perf            |
| progress | XP shares, killer credit, gold loss only on wipe, respawn revives all, recruits buy with the purse, follower commands act on followers, talents per hero                              |
| party    | every action (accept and reject, hash unchanged on reject), revive channel and cancel, town revive, auto-switch, dismiss to stash, give, determinism plus pinned hash                 |
| auto     | formation keeping, focus fire, protect, heal, revive, loot, town routine for all, travel together, wipe → respawn, 40k-tick 4-hero Idle soak (no split, progress), balance band, perf |
| client   | PartyView model, frames (click, F1–F4, Tab), panel (recruit, dismiss, rename, reorder, slots, config), 375 px layout, minimap dots, scene highlights and picks, feedback filtering    |
| server   | codecs round-trip companions, chunk sanitising, presence draws companions, reports per member, season monotonic, VerifiedHost replays party inputs, carry-over of a solo save         |
| e2e      | `tools/e2e/src/classic-party.ts`: import a save with gold → buy slots → recruit → rename → switch control → verified Idle → tampered control resyncs → D1 rows → restart persistence  |

**Hash policy.**

- Every pre-existing test and pinned hash must stay green **without re-pinning** throughout
  the build. This proves a party of one is bit-identical.
- Builders do not bump module versions. The integrator bumps the versions of changed modules
  once (`classic.party` 0.1.0 → 1.0.0 and every touched module) and re-pins all hashes.
- The architect re-pinned the three full-mode hashes that changed when `classic.party` joined
  the mode (auto.quests, quests.balance, platform.bank).

---

## 14. Task split (parallel, disjoint paths)

| Task           | Model | Owns                                                                                                                                                                                                                  |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-core         | opus  | `src/core/**`, `src/combat/**`, `src/monsters/**`, `src/world/**`, `src/spatial.ts`; tests `party.core/combat/monsters/world/perf`                                                                                    |
| T-progress     | opus  | `src/progression/**`, `src/items/**`, `src/talents/**`, `src/crafting/**`, `src/loot.ts`, `src/bonus.ts`; tests `party.progression/items/talents/crafting`                                                            |
| T-auto         | opus  | `src/auto/**`; tests `party.auto/idle/offline/balance/auto.perf`                                                                                                                                                      |
| T-party-module | haiku | `src/party/{actions,systems,ops}.ts` (+ new files in `src/party/` except `shared.ts`/`content.ts`), `src/debug/index.ts` (party cheat); tests `party.module/actions`                                                  |
| T-party-hud    | haiku | `client/model/party.ts`, `client/hudModel.ts`, `client/game.ts`, `client/input.ts`, `client/hud/**`; tests `hud.party`, `client.party.input`, `model.party`                                                           |
| T-party-render | haiku | `client/scene.ts`, `client/effects.ts`, `client/audio/**`, `client/gallery.ts`, `packages/ui-host/src/render.ts`, `apps/game/src/client/render/**`, `tools/qa/**`; tests `client.scene.party`, `client.effects.party` |
| T-presence     | haiku | `packages/protocol/src/{json,binary}-codec.ts` + tests, `apps/game/src/server/presence/**`, `apps/game/src/server/do/chunk.ts`, `client/presence/**`; tests                                                           |
| T-platform     | haiku | `src/rift/**`, `src/achievements/**`, `src/platform/**`, `client/persist.ts`, `client/sync/**`, `apps/game/tests/instance/verified-party.test.ts`; tests `party.platform/persist/rift`                                |

Contract files (architect, change only additively and with care):

- `src/{types,resources,components,actions,events,ids,rules}.ts`
- `src/party/{shared,content,index}.ts`
- `src/progression/hero.ts` (`spawnHeroEntity`)
- `client/contract.ts`
- `client/scene.ts` (`PickKind` only)
- `packages/protocol/src/messages.ts`
- `tests/support/harness.ts` (`spawnTestParty`)

---

## 15. QA checklist (browser, `tools/qa --url http://127.0.0.1:5174`)

1. Cheat slots plus recruits: frames appear. Gold, cyan and green outlines show. The minimap
   shows the party.
2. F1–F4 and Tab switch control. HUD orbs, bar, belt, bag and character all switch, and the
   camera pans.
3. Idle ×8 for 2 minutes with 4 heroes: they stay together, travel together, revive, and town
   trips complete.
4. Phone 390 px: frames fit, tap targets are at least 44 px, and the party panel is usable.
5. Wipe: the death screen leads to respawn in town with every member alive.

---

## 16. Out of scope

- Parties of several **players** (online co-op). The party is one player's heroes in one
  instance (`instance.maxPlayers` stays 1).
- A recruiter or tavern NPC with new art (recruiting is in the party panel, town only).
- Shared bag and per-hero gold. Gold is a single purse, and the stash is shared as before.
- Per-member control modes ("this one manual, that one idle") and formation editing beyond
  the three presets.
- New class appearances or portraits beyond the class sprites.
- Trading items between different players' parties (the wave C market stays per account).
