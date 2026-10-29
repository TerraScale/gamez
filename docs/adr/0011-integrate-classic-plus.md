# ADR 0011: Integrating the classic work and the party system onto main

- Status: accepted (integration branch `integrate-classic-plus`)
- Date: 2026-10-28

Three lines of work were built in parallel from different bases:

- `main` (438fc71): PRs #1-#3 plus the pre-merge security fixes R1-R13 and R9b (ADR 0007).
- `phase2-classic` (base 667cf80, without the security fixes): the hero outline (420da97), the
  admin dashboard (2d6efc3, ADR 0008), offline/idle progress with the admin tunable
  `classic.offlineXpPct`, boss/Auto fixes and admin analytics hooks (cda3f19, ADR 0009), and the
  quests QA follow-ups (f8d8135).
- `party-system` (base 420da97): the classic party (98293e2, a06fc81, ADR 0010).

They were merged in that order with `--no-ff` merges. This ADR records how the conflicts were
resolved where the two sides' intents met, and the rules that had to be extended so both survive.
No security check was dropped.

## 1. ADR numbering

The three branches each wrote an ADR 0007 (and phase2 an 0008). `0007-pre-merge-security-fixes`
is on main and keeps its number. The others were renumbered: **0008** admin dashboard, **0009**
offline/idle progress, **0010** classic party, and this ADR is **0011**. Cross-references in
`README.md`, `AGENTS.md`, `docs/design/*`, `docs/bench/2026-10-party.md` and `docs/secrets.md`
were updated. Code comments that say "ADR 0007 Rn" are the security fixes and are unchanged.

## 2. Merge 1: classic work onto the security fixes

- **Sync consumer (R13 + admin metrics).** Main moved the queue handler into `sync-consumer.ts`
  (exponential backoff, statement budget, DLQ consumer). Phase2 had inlined an instrumented
  consumer. The consumer keeps main's logic and gains an optional `record` hook
  (`SyncConsumerDeps.record`), which `index.ts` wires to `recordSyncMessage`. It is called once per
  applied or failed **main-queue** message, before the ack or retry. Budget-skipped messages and DLQ
  re-applies are not recorded: the dashboard's DLQ inflow is outcome `dead` on the main queue
  (admin-dashboard.md §2.7). `SYNC_MAX_RETRIES` moved next to the consumer.
- **Chat (R9, R9b, R10 + analytics).** Sockets keep the `acct:<id>` hibernation tag and the R10
  membership-sweep alarm, and gain phase2's `openedAt`, `wsOpened` and `markDoActive` (fetch and
  alarm). The send path keeps every R9b bound, and the analytics points sit next to each rejection.
- **R1 quarantine vs admin analytics.** An imported hero's state is client-authored, so its
  gameplay points (`sim.tally`, `sim.offline`: kills, gold and XP rates) would skew the game-wide
  balance metrics. `VerifiedHost.#flushTally` drops those two metrics for an imported record and
  still writes `verify.*` (verification health). Solo play, offline grants included, is unchanged.
- **R2 test vs offline segment gap.** `bank.replay.test.ts` waits eight days for the bank prune on a
  live socket. Offline §5.6 (a segment after a long silence pays the absence) now follows the next
  segment with an `offline` resync, which the test client adopts.
- **R8.** The offline/deferred-grant code never touches import data. Import still refuses gzip and
  checks `jsonWithinLimits` before any restore, and an import still clears the offline due fields.

## 3. Merge 2: the party system

- **Offline progress per member.** Phase2 rewrote the grant (measured online rate, upkeep,
  `xpPct` factor, respawn of a dead hero), and the party split the old model's XP per member.
  The merged rule (`auto/offline.ts` `partyOfflineGrant`, party.md §6.8):
  - Kills, gold, upkeep and items are party totals, from the measured rate (`AutoRate` counts every
    kill credited to the heroes' side and the purse's pickups and upkeep) or the party model (the
    acting leader's strength, monsters scaled by `lifePct`, the damage of every standing member,
    the travel term shortened by `densityPct`, gold and items scaled by `lootPct`). The 3× model
    caps apply as for a solo hero.
  - `classic.auto.rate` measures the **controlled hero's own XP share** (`partyKillXp` for the party
    size, as `progression/kills.ts` pays it). Solo is unchanged (`partyKillXp` at size 1 is
    `xpForKill`). Each standing member gets that rate scaled by its own model XP per kill, capped at
    3× its model. On the model path each member gets its model XP × `offlineModelXpPct`.
  - **`offlineXpPct` (the admin tunable) applies to every member.**
  - A dead controlled hero (a wipe, or downed while others stand) is respawned with every downed
    member before the grant, as a solo hero is (offline-idle.md §4.4). The party's old rule
    "a wiped party is refused" is replaced. A downed follower of a standing controlled hero gets no
    share.
  - Gold goes to the purse. The summary keeps the solo shape, with party totals.
- **Retreats.** Phase2 moved the retreat before the busy check and dodging, and raised the
  threshold at a boss. The party added party and revive retreats. Retreat now runs early and covers
  all three, only in the leader's `full` mode (never in `defend`). Every retreat records the boss's
  life for the boss-retreat loop. The revive hold and ally heals stay after dodging.
- **Upkeep and loot notes vs the purse.** Vendor buys, repairs and pickups pay from or into the
  purse (party) and still feed `AutoRate` upkeep and loot (offline).
- **Admin analytics per hero.** `classicAnalytics.fold` reads the `hero` tag of per-hero events:
  XP is banded by that member's level, a level-up counts that member's class, a member's death
  takes its own killer, and every member's casts count. Untagged events are the controlled hero,
  as before.
- **R1 quarantine and recruits.** The quarantine is the instance's (`VerifiedRecord.imported`), so
  every member recruited by an imported founder is quarantined too. All of its `classic_hero` rows
  (`hero`, `hero:<uid>`) carry `imported`, there is no arena build or season progress, and the bank
  is refused. Only a fresh game clears the quarantine. This is covered by `verified-party.test.ts`.
- **R11 vs companion names.** Party presence relayed each companion's typed hero name to every
  player in town, which is exactly the free-text channel R11 closed for pose tags. Companion names
  are now game-data words: the client reports the companion's **class name**, and the ChunkDO keeps
  a companion only when its name is in the world's `tagWords` (`sanitiseCompanions(v, tagWords)`).
  A world without a vocabulary relays no companions. Remote players see "Rogue" next to a rogue
  companion. The owner still sees its own heroes' names in its HUD.
- **Outline.** Both sides changed the outline. The controlled hero keeps `self`, members are
  `party`, remote companions `ally`, and a downed self or party outline dims.
- **Module versions.** Both sides bumped `classic.auto` (0.6.0), `classic.items` (1.3.1),
  `classic.crafting` (1.1.1) and `classic.monsters` (0.4.1). `contentHash` changes, so persisted
  instances carry over (or restart with `content_changed`) as usual. Pinned sim hashes were re-pinned
  where the merged content or behaviour changed. Determinism (same seed and script give the same
  hash) holds everywhere.

## Consequences

- An admin sees no gameplay tallies for imported heroes. Their verification health still shows.
- A party's offline XP per member is close to what a solo hero of the same level gets (each
  member's share of a kill is about 1× a solo kill), so a party does not multiply offline XP.
- Other players no longer see the names a player gives its companions.
