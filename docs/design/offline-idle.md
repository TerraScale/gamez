# Offline and idle progress (classic)

Status: implemented (first pass: §1–§10). Second pass (this revision, §12): upkeep-net offline
gold, a same-tick double-grant guard, low-level fallback calibration, the local boot save, the
away card's turn-in hint and a permanent browser QA lens.
Related docs: `classic.md` §15 (Auto and Full Idle), `wave-B.md` §2 (verified play, VerifiedHost),
`admin-dashboard.md` §8 and §11 (tunables, analytics call sites), ADR 0005.

The rule in one sentence: **when a hero in Auto or Idle leaves the game in any way, it keeps
farming. On return it gets the time it was away (server-measured, capped at 8 h) at the hero's own
online Idle rate. XP is paid at 20 % of that rate, which an admin can change at runtime. Gold
(net of upkeep), items and quest kills are paid at 100 %.**

---

## 1. Terms

| Term                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online Idle rate     | What the controller (`classic.auto.think`) earns per **sim tick** while the control mode is Auto or Idle: credited kills, the XP of those kills, and gold picked up from the ground. It is measured per hero by `classic.auto.rate` (§4.1). Because it is per sim tick, the x2..x8 speed does not change it: offline time is credited at **x1** (20 ticks per second). Speed is only for the foreground. |
| Absence (`awayMs`)   | Wall time with no verified sim progress: the server's `now - lastActiveAt` (§5.1). In local play (no server) it is the client clock from the last save or from when the tab was hidden (§7).                                                                                                                                                                                                             |
| Credited time (`ms`) | `min(awayMs, offlineCapMs)`. The default cap is 8 h. Only whole minutes count.                                                                                                                                                                                                                                                                                                                           |
| Grant                | One dispatch of `classic.offlineProgress` (server-only in server play). It queues `grantXp`, `grantGold` and `grantItems`, credits kill quests and emits `classic.offline.summary`.                                                                                                                                                                                                                      |
| Factors              | `xpPct`, `goldPct` and `itemPct`: the percent of the online rate paid offline. The defaults are 20 / 100 / 100 (BalanceProto `offlineXpPct`, `offlineGoldPct`, `offlineItemPct`).                                                                                                                                                                                                                        |

## 2. What continues on exit

Eligibility (`policy.ts` `classicOfflineEligible`) is: phase `play`, a hero exists, and
`ControlState.mode !== "manual"`. It is read from the **last verified state**. A hero in Manual
does not farm while away (§9).

| How the player left                               | Server-synced play                                                                                                      | Local play (no server)                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Closes the tab or app, reloads                    | Next join grants the absence (§5.2). Pending segments in the cache no longer block it.                                  | Boot grants `now - savedAt` (pagehide saves).                                          |
| Leaves classic to the mode picker                 | Teardown closes the socket. The return join grants.                                                                     | Same as a reload.                                                                      |
| Tab hidden or app switched (socket may stay open) | On return after at least `HIDDEN_RECONNECT_MS` (60 s) the client rejoins, **whatever is pending**, and the join grants. | On return after at least 60 s the client dispatches the grant itself (§7), then saves. |
| Loses the connection while the tab stays visible  | The client keeps playing locally (up to `maxPendingTicks`). The rejoin replays that play, then grants the rest (§5.3).  | n/a                                                                                    |
| Switches device                                   | The new device has no cache, or one that cannot continue. It adopts the server snapshot plus the grant.                 | Each device has its own save. There is no cross-device credit.                         |
| Hero was dead in the last verified state          | Eligible. The grant respawns the hero first (§4.4).                                                                     | Same.                                                                                  |

On return the following are preserved: `ControlState` (mode, speed, config), the hero and its
items. The away summary is shown (§6). The Idle mode and its speed are never reset by a return.

## 3. Rates and factors

- XP: **20 % of the online Idle XP rate** by default (`BalanceProto.offlineXpPct = 20`).
  The admin tunable `classic.offlineXpPct` (protocol `admin.ts` `TUNABLES`, 0..100, step 1, default 20) overrides it at runtime (§8).
- Gold: **100 %** (`offlineGoldPct = 100`) of the measured **net** gold rate: ground-gold pickups,
  plus junk-sale gold for the dropped items that are not kept, **minus upkeep**. Upkeep is the gold
  the hero pays online, on Auto/Idle ticks, for potions and town portal scrolls (alchemist) and
  for smith repairs (`AutoRate.upkeep`, §4.1). Offline the hero drinks nothing and wears nothing,
  so without this deduction an absence paid 1.1–12× the online net gold (second audit, 60 min x1
  probes). Gambling, smith item purchases, crafting, talent resets and rift fees are
  discretionary: they turn gold into items or power, and the player keeps that choice, so they
  are not deducted. The net is floored at 0. **A grant of 0 gold is correct, not a bug**, for a
  hero whose online Idle spends what it finds: 60-minute Idle probes (x1, seed 41) show the
  online wallet of a warrior and a rogue flat (0–3 000 gold, often emptied to under 20 by potion
  buys), and over the same 20 minutes the online farming net (ground gold + vendor sales −
  potions/scrolls − repairs) and the 20-minute grant agree: warrior 47 → 70, rogue 702 → 680,
  sorcerer 6 026 → 5 809 (seed 41); warrior −662 → 0, rogue 1 566 → 1 480, sorcerer 4 357 →
  4 281 (seed 7). Online wallet growth comes from quest and achievement gold, which are one-off
  rewards a grant never repeats (quests are not turned in offline). The card shows the gold
  found and the upkeep next to the net and explains a 0 (§6). **Gold is not a tunable.** Only XP is
  admin-configurable. Changing gold needs a data patch (BalanceProto), which is versioned and
  hashed.
- Items: **100 %** (`offlineItemPct = 100`) of the base rule: `min(20, floor(kills × 2 / 100))`
  magic+ items of the offline depth's item level, sent to the stash (overflow is sold at 10 %, as
  now).
- Kills (quest credit, statistics): 100 % of the measured kill rate, with no factor. Kills are
  what "happened". The factor is a reward rate and applies to XP only.
- Levels: the scaled XP goes through `addXp` (level-ups, stat and skill points, full heal),
  capped at `maxLevel`.

- Not modelled offline, deliberately: deaths (online they cost XP and gold, 0–3 per hour at x1),
  durability wear (0 broke/worn in every 60-min probe; repairs that do happen are in upkeep) and
  potion drinking (its gold cost is in upkeep). XP is already paid at 20 %, which dwarfs the
  death-loss term.

Why these defaults: the user's requirement is that offline XP is 20 % of what the hero earns
idling online. Gold and items stay at 100 % so that an absence does not make the stash or wallet
fall behind the XP (the economy sinks still apply on return). Offline gold is bounded by the
measured rate and by the cap in §4.2.

## 4. The offline formula (`auto/offline.ts`, `auto/rate.ts`; deterministic sim code)

### 4.1 Measuring the online rate: `classic.auto.rate` (post 950, `SYSTEM.autoRate`)

Resource `RES.autoRate` (`resources.ts` `AutoRate`: `{ ticks, kills, xp, gold, loot }`, all
integers) is created lazily on the first eligible tick, so Manual-only games never have it. Each
tick:

1. If phase is not `play`, the hero is 0, or `control.mode === "manual"`: when the resource
   exists and `loot !== 0`, set `loot = 0` (manual pickups never count). Return.
   Likewise `spent = 0` (manual purchases never count as upkeep).
2. Otherwise (Auto or Idle, alive, dead or in town alike): `ticks += 1`. For each credited death
   in `busOf(world).deaths` (`creditTeam === "hero" && !isHero && rarity !== "summon"`, the same
   filter as `progression/kills.ts`): `kills += 1`, and `xp += xpForKill(bal, heroLevel,
   d.level, d.xp)` and `pool += d.xp` (the raw XP, used by the party grant) when `d.xp > 0`
   (heroLevel = the current `Level.level`). Then `gold += loot`,
   `loot = 0`, `upkeep = (upkeep ?? 0) + (spent ?? 0)`, `spent = 0`. A new resource starts with
   `upkeep: 0, spent: 0`; a rate saved before the second pass reads both as 0 and gets them
   written on its next eligible tick.
3. If `ticks > AUTO_RATE_WINDOW_TICKS` (36 000 = 30 min at x1): halve `ticks`, `kills`, `xp`,
   `gold` and `upkeep` (floor each). This keeps a decaying window that follows the hero's current
   power.
4. `setResource`.

`noteLootGold(world, amount)` (`resources.ts`) is called by the ground-gold pickup in
`items/ground.ts` and adds to `loot` only when the resource exists. `noteUpkeepGold(world,
amount)` (`resources.ts`, same pattern, adds to `spent`) is called by the alchemist potion and
scroll purchase (`items/vendor.ts` `execBuy`) and by the smith repair (`crafting/ops.ts`
`execRepair`; the shared `pay()` helper is untouched, so upgrades, rerolls and sockets never
count), with the gold actually paid. These two functions are the only potion, scroll and repair
paths: the Auto controller's town trips queue the same `buy` and `repair` commands. Like a manual
pickup, a purchase the player makes by hand while in Auto/Idle (a manual override) is on an
eligible tick and counts. Grants (quest, achievement,
rift, bank, offline, debug) never call it, so they are never counted and an offline grant cannot
feed the rate.

### 4.2 The grant (`classic.offlineProgress {elapsedMs, xpPct?}`)

`parse`:

- `elapsedMs` is an integer in 1..7 d.
- `xpPct`, if present, is an integer in 0..100.
- Any other field is `bad_payload`.

`apply`, with `bal = BalanceProto` and `hz = 20`:

```
ms       = min(elapsedMs, bal.offlineCapMs)            minutes = floor(ms / 60000)
T        = minutes × 60 × hz                              (credited sim ticks at x1)
model    = computeOffline(...)                            (the §15.4 model; kills per §4.3)
fbXp     = floor(model.xp × bal.offlineModelXpPct / 100)  (fallback XP ≈ online, see §4.3)
rate     = RES.autoRate
if rate && rate.ticks >= AUTO_RATE_MIN_TICKS (6 000 = 5 min):        source = "rate"
  kills  = min(floor(rate.kills × T / rate.ticks), model.kills × 3, 120 × minutes)
  baseXp = min(floor(rate.xp × T / rate.ticks), fbXp × 3)          (no model floor, §4.3)
  itemsB = min(20, floor(kills × 2 / 100))
  upkeep = floor((rate.upkeep ?? 0) × T / rate.ticks)
  baseGold = clamp(floor(rate.gold × T / rate.ticks) + junkGold(kills, itemsB) − upkeep,
                   0, model.gold × 3)
else:                                                               source = "model"
  kills = model.kills; baseXp = fbXp; itemsB = model.items; upkeep = 0
  baseGold = floor(model.gold × (bal.offlineModelGoldPct ?? 100) / 100)
xpPct    = payload.xpPct ?? bal.offlineXpPct
xp       = floor(baseXp   × xpPct / 100)
gold     = floor(baseGold × bal.offlineGoldPct / 100)
items    = floor(itemsB   × bal.offlineItemPct / 100)
junkGold(k, kept) = max(0, floor(k × drops.normal.item / 100) − kept) × junkPrice(monsterLevel(depth))
levels   = min(bal.maxLevel, levelForXp(bal, Level.xp + xp)) − Level.level
```

The `× 3` caps are a sanity bound against a spiky window, not a balance lever. Since the second
pass the model's kills are at most 20 a minute (travel term, §4.3), so the kill bound is at most
60 a minute; online Idle measured 12–32 kills a minute (10-minute means, L1–L16). The rate path
has **no** model floor (integration pass, §4.3): the offline XP is exactly `xpPct` of the
measured online Idle XP rate, never more. Gold has no floor either: a gross-gold floor would pay
warriors, whose online net gold is about 0 in their first 40 minutes, 80–270 gold a minute. Products stay far below 2^53: `rate.xp` is at most about 10^7 and `T` at
most 576 000.

`OfflineResult` gains `depthIds: string[]` (from `depthMonsterIds`, computed once, review #10),
`source`, `xpPct`, `goldPct` and `itemPct`. `computeOffline` remains the exported pure model. A
new exported `offlineGrant(world, reg, hero, elapsedMs, xpPct)` returns the final numbers, and
both the action and the tests use it.

### 4.3 Fallback model calibration

**Second pass (done, T2-sim).** The audit found the fallback model at ~7–10 % instead of 20 % for
a fresh L1 warrior (5 kills / 18 XP per minute after the factor, against ~250 XP/min online). The
target: for warrior, rogue and sorcerer at L1 (fresh) and after 5 minutes, the grant's XP before
the factor (xpPct 100) is within **0.6–1.5×** the measured online kill XP per minute over the
**following** 10 minutes of Idle x1, and the L10–L17 points stay in the same band. Gold target:
0.5–2× the online net gold (ground + junk − potions, scrolls and repairs; discretionary spending
excluded).

**What the measurement showed** (throwaway script, real catalog, seeds 7, 2026 and 11 as a holdout,
45 minutes of Idle x1 per hero, grants taken at minutes 0–35):

1. Online Idle kills are flat: 12–32 a minute (10-minute means) at every level from L1 to L16,
   whatever the class. Walking, looting and town trips bound them, not damage. The old model's
   kills followed damage only (`dps × 35 %`): 5 a minute for an L1 warrior or rogue (basic attack
   only), 23–37 a minute once a skill is learned at L2. Hence 0.36–0.46× at L1 for warrior and
   rogue, 1.3–2.1× for the sorcerer, and about 2× at L2–L3.
2. The measured rate trails a hero that is still growing. Its window averages up to 30 minutes,
   while online XP a minute roughly triples between minute 5 and minute 30. After 5 minutes it
   paid 0.23–0.94× and after 30 minutes 0.25–0.70×. A shorter window (12 000 ticks, emulated)
   only moved the 30-minute points to 0.28–0.85×.
3. Online net gold is the difference of two similar numbers early on. Warriors spend about all
   their ground gold on potions (net −240 to +90 a minute up to L13). Rogues and sorcerers net
   +40 to +980 a minute.

**Chosen numbers** (smallest change that meets the XP target):

- `computeOffline` kills: time per kill = fight ticks + `OFFLINE_TRAVEL_TICKS` (**60**, a
  constant in `auto/offline.ts`). Fight ticks = `avgLife × ticks × 100 / (dmg ×
  offlineEfficiencyPct)`. `killsPerMin = clamp(floor(1200 / time per kill), 1, 120)`, which is at
  most 20.
- `offlineEfficiencyPct` **35 → 100**. It now means the share of the best skill's damage that
  lands while fighting; the travel term covers the rest. `offlineModelXpPct` stays **200**:
  online XP per kill is 1.1–2.8× the normal-monster average (champions, uniques, bosses).
- `offlineModelGoldPct` = **100**. The model's gold with the new kills is 0.8× the online net gold
  (pooled median over the rogue and sorcerer points; warriors net about 0). 125 would put 45/64
  points in band instead of 40/64, but it pays more to warriors, whose online net is ≤ 0.
- Rate path (second pass): the model was the floor of the measured XP, `clamp(rateXp, fbXp, 3 ×
  fbXp)`. **Dropped in the integration pass**: the requirement test
  (`offline.requirements.test.ts`, seed 51, 10 minutes of Idle then a 60-minute absence) showed
  the floor always winning, at 0.38 (warrior), 0.75 (rogue) and 0.39 (sorcerer) of the online
  kill XP per minute at "20 %", that is 1.9–3.75× the requirement, because the model overpays at
  the depth-3 waypoint (known limit below). The rate path is now `min(rateXp, 3 × fbXp)`: offline
  XP is `xpPct` of the measured online Idle rate. A hero that is still growing gets the trailing
  rate (0.23–0.94× the next 10 minutes online, point 2), which errs on the safe side: never more
  than the requirement. The model stays the fallback for heroes with less than 5 minutes of
  measured play.
- Unchanged: `AUTO_RATE_MIN_TICKS` 6 000 and `AUTO_RATE_WINDOW_TICKS` 36 000. A lower minimum
  only swaps the calibrated model for a short, trailing rate (0.37–0.74× at minute 2–3).

**Before / after** (per minute; the ratio is grant / online). Online = the mean over the 10
minutes after the point. Before = the first-pass code. Gold "before" is the gross rate (no
upkeep).

| Hero, seed    | Min | Level, depth | Source | Online XP | XP before  | XP after     | Online net gold | Gold before | Gold after |
| ------------- | --- | ------------ | ------ | --------- | ---------- | ------------ | --------------- | ----------- | ---------- |
| warrior 7     | 0   | L1 d1        | model  | 248       | 90 (0.36)  | 162 (0.65)   | −3              | 17 (n/a)    | 30 (n/a)   |
| warrior 7     | 5   | L4 d1        | rate   | 337       | 144 (0.43) | 288 (0.85)   | −71             | 78 (n/a)    | 66 (n/a)   |
| warrior 7     | 30  | L11 d5       | rate   | 1 191     | 431 (0.36) | 962 (0.81)   | 789             | 185 (0.23)  | 0 (0.00)   |
| rogue 7       | 0   | L1 d1        | model  | 206       | 90 (0.44)  | 162 (0.79)   | −7              | 17 (n/a)    | 30 (n/a)   |
| rogue 7       | 5   | L4 d1        | rate   | 266       | 158 (0.59) | 288 (1.08)   | 99              | 29 (0.30)   | 17 (0.18)  |
| rogue 7       | 30  | L10 d5       | rate   | 882       | 355 (0.40) | 888 (1.01)   | 194             | 247 (1.27)  | 139 (0.71) |
| sorcerer 7    | 0   | L1 d1        | model  | 195       | 414 (2.13) | 270 (1.39)   | 58              | 77 (1.33)   | 50 (0.86)  |
| sorcerer 7    | 5   | L3 d1        | rate   | 433       | 100 (0.23) | 288 (0.67)   | 231             | 35 (0.15)   | 23 (0.10)  |
| sorcerer 7    | 30  | L12 d7       | rate   | 1 033     | 606 (0.59) | 1 274 (1.23) | 909             | 436 (0.48)  | 377 (0.41) |
| warrior 2026  | 0   | L1 d1        | model  | 232       | 90 (0.39)  | 162 (0.70)   | −6              | 17 (n/a)    | 30 (n/a)   |
| warrior 2026  | 5   | L4 d1        | rate   | 262       | 218 (0.83) | 288 (1.10)   | 1               | 93 (n/a)    | 0 (0.00)   |
| warrior 2026  | 30  | L11 d5       | rate   | 747       | 397 (0.53) | 888 (1.19)   | −120            | 253 (n/a)   | 14 (n/a)   |
| rogue 2026    | 0   | L1 d1        | model  | 198       | 90 (0.46)  | 162 (0.82)   | 42              | 17 (0.39)   | 30 (0.71)  |
| rogue 2026    | 5   | L4 d1        | rate   | 222       | 176 (0.80) | 288 (1.30)   | 146             | 68 (0.47)   | 22 (0.15)  |
| rogue 2026    | 30  | L9 d3        | rate   | 975       | 242 (0.25) | 690 (0.71)   | 251             | 148 (0.59)  | 46 (0.18)  |
| sorcerer 2026 | 0   | L1 d1        | model  | 319       | 414 (1.30) | 270 (0.85)   | 136             | 77 (0.57)   | 50 (0.37)  |
| sorcerer 2026 | 5   | L4 d1        | rate   | 423       | 218 (0.52) | 288 (0.68)   | 232             | 81 (0.35)   | 57 (0.25)  |
| sorcerer 2026 | 30  | L13 d7       | rate   | 1 573     | 722 (0.46) | 1 274 (0.81) | 570             | 424 (0.74)  | 354 (0.62) |
| warrior 11    | 30  | L9 d3        | rate   | 390       | 274 (0.70) | 690 (1.77)   | −55             | 131 (n/a)   | 11 (n/a)   |

The table lists every seed 7 and 2026 point. Holdout seed 11 matches them, except for the one row
shown. Over all 99 grant points (9 heroes × 11 grant times, minutes 0–35), the grant is 0.6–1.5× online
XP at 82 points (range 0.46–2.59), against 22 points before (range 0.23–2.45). Every L1 and
5-minute point is in band. At L10–L17 (minutes 30–35), 16 of 18 points are in band. In this
early-game data the model floor always set the XP (the trailing rate never exceeded it).

**Known limits** (honest, not tuned away):

- **The depth-3 waypoint at L5–L9 (warrior and rogue): the model pays 1.5–2.6×.** The waypoint
  counts as reachable from L3 (`monsterLevel 4 ≤ L + 1`). Online, melee heroes kill only 5–20 a
  minute there and often farm depths 1–2 for quests. With the 20 % factor this is 30–50 % of
  online XP for roughly minutes 10–25 of a new hero.
- **Rate-path gold is 0–0.7× the next 10 minutes' net gold in the first 40 minutes.** It is the
  trailing measured net, and early upkeep is heavy. This is conservative by design. The emulated
  alternative (forward model gross × the measured net share) reached 33/46 points in band but
  paid warriors with ≤ 0 online net about 35 gold a minute. Not adopted.
- The reference ("the next 10 minutes online") itself swings ±50 % between neighbouring windows
  (boss kills, town trips). A single point outside the band is not a regression by itself.

The "after" XP column of the rate rows above is the second pass (with the floor); since the
integration pass those rows pay the "before" column (the measured rate).

Pinned by `modules/classic/tests/offline.economy.test.ts` ("low-level calibration": seed 2026,
each class: the model at L1 is 0.6–1.5× the next 10 minutes online; after 5 minutes the rate path
pays 0.95–1.05× the measured online kill XP of those 5 minutes).

### 4.4 Other rules in `apply`

- No hero gives `no_hero`.
- **Dead hero**: the absence covered the respawn delay. Set `Dead.at = min(Dead.at, tick −
  bal.respawnDelay)` and run `execRespawn` **in the action, before** the grants are queued (to
  town, full heal). As built, this is not a queued `respawn` command: a queued respawn raced the
  controller's own respawn on the same tick, and the loser emitted `classic.command.failed`.
- `minutes <= 0`: emit the summary with zeros and grant nothing. The server never sends less than
  60 s.
- Quest credit: `creditOfflineKills(world, ctx, kills, depthIds)` with the **unscaled** kills (the
  rule is unchanged, classic.md §16 (d)).
- `RunStats.offlineMs += ms`.
- **Same-tick guard** (second pass): if `RunStats.offlineAt === ctx.tick`, throw
  `ActionError(ERR.offlineTwice)` before anything else changes; otherwise set
  `RunStats.offlineAt = ctx.tick` together with the grant. Callers already prevent double grants
  (§5.5, §7); this makes a double local dispatch harmless in the sim itself. A zero-minute grant
  also sets it. **The verified server (actor `"server"`) is exempt** (integration pass): after a
  grant the server tick does not move until the client plays, so a player who adopts a grant and
  leaves at once would have the next absence refused, after the host had already consumed it (the
  hours were lost). The host pays measured absences only and resets `lastActiveAt` with every
  grant, so it never needs the guard.
- Emit `classic.offline.summary` with every field of `events.ts`: `ms, awayMs (= elapsedMs),
  capMs, depth, kills, xp, gold, items, levels, xpPct, goldPct, itemPct, source, upkeep`
  (`upkeep` = the gold already deducted, 0 for the model).

## 5. Server flow (VerifiedHost)

### 5.1 `lastActiveAt` = wall time of the last verified sim progress

- It is set when a segment with `toTick > fromTick` verifies, when a grant is made, and for a new
  game or an import.
- `handleClose` **no longer** sets it to now. Before, the old socket's close arrived just before a
  hidden-tab rejoin and erased the absence.
- Segments that cover 0 ticks (a throttled hidden tab) do not move it.

### 5.2 Join decision

Definitions:

- `elapsed = now − rec.lastActiveAt`
- `canContinue = resume && ancestors.get(resume.tick) === resume.hash`
- `U = canContinue && resume.pendingToTick > rec.verifiedTick ? resume.pendingToTick − rec.verifiedTick : 0`
  (unverified play the client still holds)

| Case                                                                                              | Action                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fresh, new, carried or reset                                                                      | No grant (as now).                                                                                                                                                                                          |
| `U === 0` and not eligible                                                                        | No grant. Clear the due fields and set `lastActiveAt = now`: the absence was not farmed and is never paid later.                                                                                            |
| `elapsed + rec.offlineDueMs < minMs`                                                              | No grant.                                                                                                                                                                                                   |
| `U === 0` (nothing pending, or pending is already verified, or the client cannot continue anyway) | **Grant now** for `min(elapsed + offlineDueMs, capMs)`. Clear the due fields. `continued = false`, so the client adopts the snapshot. `resume.pending` alone never blocks a grant any more.                 |
| `U > 0`                                                                                           | **Defer** (§5.3): `offlineDueMs += max(0, elapsed − U × msPerTick)`, `offlineDueTick = resume.pendingToTick`. Persist the meta, continue as now (no grant), and let the client resend its pending segments. |

As built, the decision runs in this order:

1. `U > 0` defers, **whatever the eligibility of the verified state**. The pending play may switch
   to Auto/Idle just before leaving (the player taps Idle and closes the tab). The deferred grant
   checks eligibility on the caught-up state (§5.3).
2. A deferring join also sets `lastActiveAt = now`. The absence has moved into `offlineDueMs`, so a
   second rejoin before the catch-up does not count it twice.
3. A non-offline resync (hash mismatch, gap…) while time is owed lowers `offlineDueTick` to
   `verifiedTick`, so the next verified segment pays the debt instead of waiting for U more ticks.

### 5.3 Deferred grant

When a segment verifies with `rec.verifiedTick >= rec.offlineDueTick` and `rec.offlineDueMs > 0`:

- If `offlineDueMs >= minMs` and the hero is eligible **at that verified state**: dispatch the
  grant (same helper as the join), compact, bump the epoch, reset the ledger and `lastActiveAt`,
  and send `resync {code: "offline", offline: grant, snapshot}`. The client adopts it and loses
  only the few ticks it ran past that point.
- Clear the due fields in every case.

If the client leaves before catching up, the due fields are durable (VerifiedRecord meta, with a
default of 0 for old rows), and the next join adds them (§5.2). The `U × msPerTick` estimate
assumes x1. At x2..x8 it subtracts more than the real local play time, so it can only underpay.

### 5.4 Tunables and determinism

- `VerifiedHostDeps.offlineTunables?(): Promise<Readonly<Record<string, number>>>`. The host
  awaits it right before a grant and fails open to `{}`. InstanceDO wires it to
  `(await currentConfig(env))?.tunables ?? {}` (`config/flags.ts`, 10 s isolate cache). An admin
  change therefore takes effect on grants within about 10 s.
- The payload is `policy.offline.payload?.(elapsedMs, tunables) ?? { elapsedMs }`. The classic
  `classicOfflinePayload` adds `xpPct` (rounded, clamped to 0..100) only when the tunable is a
  finite number. Otherwise the sim default `offlineXpPct` applies.
- Determinism: the effective factor is in the dispatch payload, the grant is compacted into the
  base at once, and clients can never send `classic.offlineProgress` (`serverOnlyActions`).
  Replays never see it. Local play uses the balance default.
- One private helper `#grantOffline(sim, elapsedMs, tunables): OfflineGrant | null` makes every
  grant. It calls `tally.offline(...)` for the admin dashboard (admin-dashboard.md §11.2).
- Every config read is the full `ConfigResponse.tunables`, which carries every spec key (stored
  value or the spec default 20), so in practice the payload always has `xpPct`; the balance
  default only applies when ConfigDO is unreachable (`{}`), and both defaults are 20.

### 5.5 No double grant, no loss

- A grant resets `lastActiveAt`, the ledger and the due fields, and compacts, so the old resume
  hash is no longer an ancestor.
- Joins are serialised, and the newest socket wins.
- A reload after a grant sees `elapsed ≈ 0`.
- An import never grants.
- Backstop for local play: the sim rejects a second local grant on the same tick (§4.4); the
  server's grants are exempt.
- A client that never received the vstate (socket died) rejoins with a resume that cannot
  continue. It adopts the base, which already contains the grant, but the summary is gone. That
  is acceptable: the progress itself is not lost.

### 5.6 A segment after a long silence (integration pass)

A page frozen in the background (mobile app switch, a discarded or frozen tab, laptop sleep) keeps
its socket. On resume it may send a queued segment on the old socket **before** its
`visibilitychange` rejoin (QA probe, `/tmp/gamez-qa-dprobe`). That segment used to verify, set
`lastActiveAt = now` and erase the absence; the speed credit got it instead.

Rule (`VerifiedHost.#segmentGap`, after a segment with progress verified and nothing is owed
yet): `gap = now − max(previous lastActiveAt, last join) − the segment's own play time
(costMs)`. When `gap >= minMs`, it becomes owed (`offlineDueMs = gap`, `offlineDueTick =
verifiedTick`) and the deferred grant (§5.3) pays it at once, with eligibility checked on the
verified state: resync `"offline"`. The page's own rejoin right after continues from that state
with no second grant. Measuring from the last join keeps a short absence (no grant, `lastActiveAt`
unchanged) plus a little play from adding up to a grant. Manual heroes are never paid (not
eligible). Tests: `verified-offline.exit.test.ts` ("a page frozen with its socket open").

## 6. Away summary (client)

- `classic.offline.summary` opens a dismissable **"While you were away"** card. The log line
  stays. The card shows:
  - away time, and credited time with a "(capped at 8 h)" note when `awayMs > ms`
  - kills, with `+XP (20 % offline rate)`, `+gold (100 %)` and `items → stash`
  - levels gained (`+2 levels`) and quest progress from the same event batch
    (`classic.quest.progress` / `.done`). A quest that became done offline reads
    **"done, turn in at the quest giver"**: offline grants never turn quests in; the Idle
    controller does that on its next town visit.
  - the gold line says `(found F, net of N upkeep)` when `upkeep > 0` (`found`: the gold found
    before upkeep, `classic.offline.summary.found`, capped with the gold so that
    `gold = max(0, found − upkeep)`; an older server without `found` shows `(net of N upkeep)`),
    and a gold grant of 0 with upkeep adds the line "Potions, scrolls and repairs cost what Idle
    finds here, as they do online" (fix round 2)
  - a "measured" or "estimated" hint from `source`
  - the rates in force: `Offline rates: XP 20% · gold 100% · items 100%` (integration pass; the XP
    rate is the effective admin value of that grant)
- Mobile first: 44 px targets, fits 375 px. It replaces the long toast (a short toast is fine as
  well).
- Timing (fix round 2): the action only queues `grantXp` / `grantGold` / `grantItems`, which run
  on the next sim step. `game.ts` therefore holds a batch with `classic.offline.summary` (a local
  dispatch, or a server grant adopted through `emit`) until the next step and fans it out right
  after it with a fresh HUD, so the card never shows next to the pre-grant XP, level or gold.
  The QA lens's "XP since leaving ≥ the card's XP" read in phases C and D sampled exactly that
  window (sample tick = adoption tick, HUD refreshed every 100 ms).
- A zero grant (0 minutes) shows nothing.

## 7. Local play (no server)

- Boot keeps its rule: `now − savedAt > OFFLINE_MIN_MS` while eligible dispatches the grant with
  `{elapsedMs}` (no `xpPct`, so the balance default applies). Second pass: boot goes through the
  same `grantLocalAway` helper, so the grant is **saved at once** (before, a reload inside the
  10 s autosave window re-measured from the older save; not a double grant, but inconsistent).
- **New:** on `visibilitychange` to visible with `away >= OFFLINE_MIN_MS`, no active sync and an
  eligible hero (share `classicOfflineEligible`), dispatch the same grant with `elapsedMs = min(away,
  OFFLINE_MAX_MS)` and then `game.save()`. The FixedLoop drops gaps over 1 s, so nothing is
  counted twice.
- A later reload measures from the save made right after the grant, so there is no double grant.

## 8. Admin: changing the offline XP factor

- Dashboard → Flags & config → tunable **Offline XP** (`classic.offlineXpPct`, 0..100 %, step 1),
  or `POST /api/admin/tunables {"values": {"classic.offlineXpPct": 35}}`. The admin-dashboard
  workflow owns this. Storage is ConfigDO `config_tunable`, with audit.
- It takes effect on the next grant (≤ 10 s isolate cache). Past grants are unchanged. No
  redeploy, no content hash change.
- If ConfigDO is unreachable, or the key is unset, the balance default (20) applies.
  `TUNABLES[...].default` must equal `BALANCE.offlineXpPct` (pinned by a test).
- Local play always uses the balance default.

## 9. Anti-abuse

- Time is measured by the server. Clients cannot dispatch the action, and the payload is capped at
  7 d by the host and 8 h by the sim.
- The rate is measured only from verified Auto/Idle ticks. Grants and bank moves never count
  toward it. There is a `× 3` model cap, and the 30-minute decaying window means a short burst
  cannot be banked.
- Manual heroes earn nothing offline, so there is no "AFK in manual" farming. Switching to Idle
  just before leaving uses the measured rate if there is one, otherwise the conservative model.
- A grant restarts the speed ledger at `START_CREDIT_MS` (no double dip with the speed credit).
- Deferred grants subtract the client's unverified play time (x1 estimate, so they underpay).

## 10. Review findings (uncommitted Auto/boss/offline changes): decisions

| #   | Finding                                                       | Decision                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fightingBoss()` resets the watchdog every tick               | **Fix.** `AutoState.bossE?`/`bossHp?` hold the focused boss and the lowest life seen. A boss tick resets `killAt`/`hops` only when the focus changed or `Life.hp < bossHp`. Otherwise the drought and loop counters run.                                                      |
| 2   | `bossHalfDown` overrides `retreatLoop` with no progress check | **Fix.** `noteRetreat` records the live boss's hp at this depth (`AutoRetreats.bossHp`, −1 when none) and the previous value (`prevBossHp`). The override needs `bossHp >= 0 && prevBossHp > bossHp` (the boss lost life between the two retreats).                           |
| 3   | `huntBoss` before exploring, ignoring fog                     | **By design.** classic.md §15.2 step 10 and §15.5 document and measure it. Waypoints unlock on entering a level. Fights and loot still run before `dungeonStep`. No change.                                                                                                   |
| 4   | melee phase minions +6 tiles at any distance                  | **Fix.** Apply the penalty only when `f.dist > 2 × TILE`, as for normal summons. An adjacent minion that body-blocks the hero is fought.                                                                                                                                      |
| 5   | `retreatLoop` misses alternating depths                       | **Fix.** Remember three retreats (`prev2?`). Loop = the last retreat is within W, and either (the last two are within W at the same depth) or (`prev2` exists and the last three are within 2W, whatever their depths). W = `RETREAT_LOOP_TICKS`. Old saves behave as before. |
| 6   | QA quests.ts else-branch                                      | **Fix.** Branch on the quest state: `completed` (check gold/XP rise; the toast check is warn-only), `active` (no reward check, `ashTurnedInBy = "not finished"`), otherwise an explicit failure that names the state.                                                         |
| 7   | dodge test loosened                                           | **Fix.** Count the telegraphs aimed at the hero and assert hits per telegraph: `d.hits/d.telegraphs < 0.75 × s.hits/s.telegraphs`, with both > 0.                                                                                                                             |
| 8   | quest offline expectation uses the same formula               | **Fix.** Pin concrete numbers (summary depth, kills, `ids.length`, exact Ash/Rats progress) for the fixed seed, plus one case with a named target in the list and a non-zero share.                                                                                           |
| 9   | `bossHalfDown` duplicates `liveBoss`                          | **Fix.** `liveBoss(c, depth = c.depth)`.                                                                                                                                                                                                                                      |
| 10  | `depthMonsterIds` computed twice                              | **Fix.** `OfflineResult.depthIds`.                                                                                                                                                                                                                                            |

## 11. Work split (first pass, done)

| Task     | Model | Owns                                                                                                                                                                                                                                                                                                  |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-server | opus  | `apps/game/src/server/instance/verified-{host,messages,store}.ts`, `apps/game/src/server/do/instance.ts` (one dep), `modules/classic/src/client/sync/**`, the tests of those (`apps/game/tests/instance/verified-*.test.ts`, `quests-verified.test.ts`, `modules/classic/tests/client.sync*.test.ts`) |
| T-sim    | haiku | `modules/classic/src/auto/{offline,rate,index}.ts`, `modules/classic/src/items/{ground,index}.ts`, `modules/classic/tests/{auto.test,auto.quests.test,auto.offline.quests.test}.ts`                                                                                                                   |
| T-auto   | opus  | `modules/classic/src/auto/{think,town,util,fight,dungeon}.ts`, `modules/classic/src/components.ts` (AutoState fields only), `modules/classic/tests/{bosses.test,auto.bosses.test,auto.review.test}.ts`, `tools/qa/src/quests.ts`, `docs/design/classic.md`                                            |
| T-client | haiku | `modules/classic/src/client/{effects,index,hudModel}.ts`, `modules/classic/src/client/hud/widgets/AwaySummary.tsx`, `modules/classic/src/client/hud/index.tsx`, `modules/classic/tests/client.away*.test.tsx`                                                                                         |
| T-tests  | haiku | `modules/classic/tests/offline.rates.test.ts`, `modules/classic/tests/offline.contract.test.ts`, `tools/e2e/src/classic-offline.ts`, `tools/e2e/src/e2e.ts` (one step)                                                                                                                                |

Pinned hashes: the balance data change (this contract) and the behaviour changes alter almost
every pinned `sim.hash()` and registry hash in `modules/classic/tests` and `apps/game/tests`.
**Tasks do not edit pinned hashes in files they do not own.** After every task lands, the
integrator re-pins them in one pass, after checking that the only remaining failures are
hash pins. Module versions: `classic.content` is 0.4.0 (done here). T-sim sets `classic.auto`
0.4.0 (which covers T-auto's changes too) and bumps `classic.items` by a patch.

## 12. Second pass (audit of the implemented code)

Gates before this pass: `vp check` clean, `modules/classic` 1 719 tests and `apps/game` 1 870
tests green. All ten review findings (§10) are fixed and have regression tests
(`auto.review.test.ts` #1 #2 #4 #5 #9, `bosses.test.ts` #7 hits per aimed telegraph,
`auto.quests.test.ts` #8 pinned numbers, `offline.ts` `depthIds` #10, `tools/qa/src/quests.ts`
#6). Remaining findings and their owners:

| Finding (audit)                                                        | Decision                                                                                    | Task      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------- |
| Offline gold ignores upkeep: 1.1–12× online net gold (major)           | Done: net upkeep at the measured rate (§3, §4.1, §4.2); `offlineModelGoldPct` 100           | T2-sim    |
| Fallback model ≈ 7–10 % instead of 20 % at L1 (minor)                  | Done: travel-limited model kills, `offlineEfficiencyPct` 100, model floor on rate XP (§4.3) | T2-sim    |
| `offlineProgress` not idempotent (minor)                               | Done: same-tick guard `RunStats.offlineAt` (§4.4)                                           | T2-sim    |
| Local boot grant not saved at once (minor)                             | Boot uses `grantLocalAway` (§7)                                                             | T2-client |
| Offline-done quests not shown as "turn in" on the card (minor)         | Card hint (§6)                                                                              | T2-client |
| Deaths, durability, potions not modelled offline (minor)               | Documented as deliberate (§3); potions and repairs are in upkeep                            | (doc)     |
| Browser exit → return in server mode never verified (probe unfinished) | Permanent QA lens `tools/qa/src/offline.ts`, run against :5173                              | T2-qa     |
| Requirements-level tests across layers                                 | `offline.requirements.test.ts`, `verified-offline.exit.test.ts`, e2e step                   | T2-tests  |

Contract written for this pass (all optional or additive, no behaviour change on its own):
`BalanceProto.offlineModelGoldPct?`, `AutoRate.upkeep?` / `spent?`, `noteUpkeepGold()`,
`RunStats.offlineAt?`, `ERR.offlineTwice`, `classic.offline.summary.upkeep?`, and
`ActionPayloads["classic.offlineProgress"].xpPct?`.

Versions: T2-sim bumps `classic.auto` (0.4.1 → 0.5.0), `classic.items` (1.2.3 → 1.2.4),
`classic.crafting` (1.0.0 → 1.0.1) and `classic.content` (0.4.1 → 0.4.2). Pinned hashes in files
a task does not own are re-pinned by the integrator in one pass, after checking that the only
remaining failures are hash pins.

## 13. Integration pass

Decisions (ADR 0009):

| Finding                                                                         | Decision                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model floor on rate XP paid 0.38–0.75 of online XP at "20 %" (requirement test) | Dropped: `baseXp = min(rateXp, 3 × fbXp)` (§4.2, §4.3). `classic.auto` 0.5.1                                                                                                        |
| An absence right after a grant, with no tick of play in between, was lost       | The same-tick guard exempts the server actor (§4.4); regression test in `verified-offline.exit.test.ts`                                                                             |
| A frozen page's queued segment on the old socket erased the absence (QA probe)  | `#segmentGap` turns a silence of at least `minMs` into owed time, paid by the deferred grant (§5.6)                                                                                 |
| Away card did not list gold/item rates                                          | `Offline rates: XP n% · gold n% · items n%` line (§6)                                                                                                                               |
| Admin dashboard hooks (admin-dashboard.md §11)                                  | `SimTally` in VerifiedHost, InstanceDO analytics (`do.active`, `ws.open`/`ws.close` kind `instance`), classic `analytics` policy hook, telemetry contentHash from the verified join |
| Admin tunable must really change offline XP                                     | e2e `classic-offline`: the admin sets 50, the server's grant equals the bot's `{ xpPct: 50 }` dispatch (hash)                                                                       |

## 14. Fix round 2 (verifier findings)

| Finding (verifier)                                                             | Verdict and fix                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gold for rogue and warrior is zero or near zero after upkeep (major)           | By design, verified: the online wallet is flat too and the grant matches the online farming net (§3 numbers). The summary now carries `found`; the card shows `(found F, net of N upkeep)` and explains a 0 (§6). Requirement test `offline.economy.test.ts` "offline gold tracks the online Idle farming net" |
| classic-offline C and D: XP since leaving < the card's XP (sample at adoption) | Real client race, not only a harness read: the card showed one step before the grant's queued XP landed (and up to one 100 ms HUD period after). `game.ts` holds the grant batch until the next step (§6). Tests: `client.away.local.test.ts`, `client.sync.test.ts` (hidden-tab rejoin)                       |
