# Arena balance matrix (arena.core 1.1.0)

Follow-up to ADR 0006 §13. A Cleave+Mend warrior beat a plain warrior 200-0 in the mirror, and a
live defender spent a daily fight and earned nothing.

Reproduce: `node --experimental-transform-types tools/bench/src/arena-balance.ts 1000` (from the repo
root). The fights are deterministic (seeds 1..1000), so the table repeats exactly. It is not a
timing benchmark, so the 3-repeat rule does not apply.

## Method

- **Archetypes** come from real classic heroes. For each class, a new hero is mapped with
  `classicArenaBuild` (the same mapping the server uses). Each class has three builds:
  - `plain`: no skills;
  - `bar`: the new hero's skill bar (warrior Cleave, rogue Fan of Arrows, sorcerer Ember Bolt);
  - `mend`: the bar plus Mend (heal 20 % of max hp, cooldown 100 arena ticks, the classic 200 ticks
    halved as in `classicArenaBuild`).
- **Cell**: the percentage of fights the row build wins when it attacks the column build over seeds
  1..1000. Draws count for neither side.
- **Overall**: each build's win rate both as attacker and as defender, over all nine opponents,
  including its mirror. Draws count as half.

## Rules changed in 1.1.0

1. **One attack slot.** Skills and basic attacks share a slot, so a basic attack is due every
   `interval` ticks and a skill cast takes that slot. A skill replaces an attack and no longer adds
   damage on top of the basics. Before, a warrior's Cleave doubled its output.
2. **Caster basic reach.** A basic attack reaches as far as the build's longest ranged skill
   (projectile or nova), with 1 tile as the minimum. Before, every build fought basics in melee
   range, so a caster walked up to its target before its basic attack landed.
3. **Live defender refund.** A live ticket that is matched as the defender gives its daily fight
   back (`ladder.ts #refundDefenderFight`). DECISION: refund rather than a defender reward. Reason: a
   reward would be a new coin faucet (AGENTS.md §11 requires a matching sink), and the refund keeps
   the attacker's fight as the only cost.

The mirror-fairness test and the pinned fight still hold. The pinned hash was re-pinned because the
module version changed.

## Results (1000 seeds per pair, row attacks column)

| attacker \ defender | warrior-plain | warrior-bar | warrior-mend | rogue-plain | rogue-bar | rogue-mend | sorcerer-plain | sorcerer-bar | sorcerer-mend |
| ------------------- | ------------- | ----------- | ------------ | ----------- | --------- | ---------- | -------------- | ------------ | ------------- |
| warrior-plain       | 40            | 14          | 12           | 100         | 99        | 97         | 100            | 100          | 100           |
| warrior-bar         | 86            | 40          | 33           | 100         | 100       | 100        | 100            | 100          | 100           |
| warrior-mend        | 88            | 63          | 41           | 100         | 100       | 100        | 100            | 100          | 100           |
| rogue-plain         | 0             | 0           | 0            | 34          | 11        | 4          | 100            | 100          | 100           |
| rogue-bar           | 1             | 0           | 0            | 69          | 40        | 42         | 100            | 100          | 100           |
| rogue-mend          | 1             | 0           | 0            | 68          | 57        | 40         | 100            | 100          | 100           |
| sorcerer-plain      | 0             | 0           | 0            | 0           | 0         | 0          | 40             | 17           | 18            |
| sorcerer-bar        | 0             | 0           | 0            | 0           | 0         | 0          | 83             | 43           | 30            |
| sorcerer-mend       | 0             | 0           | 0            | 0           | 0         | 0          | 82             | 40           | 40            |

Overall win rate per build:

| build          | as attacker win % | as defender win % | overall % | draw % |
| -------------- | ----------------- | ----------------- | --------- | ------ |
| warrior-plain  | 73.5              | 73.8              | 73.6      | 2.2    |
| warrior-bar    | 84.4              | 87.0              | 85.7      | 0.0    |
| warrior-mend   | 87.9              | 90.5              | 89.2      | 0.0    |
| rogue-plain    | 38.9              | 40.5              | 39.7      | 6.7    |
| rogue-bar      | 50.2              | 47.4              | 48.8      | 7.5    |
| rogue-mend     | 51.7              | 50.6              | 51.1      | 7.2    |
| sorcerer-plain | 8.3               | 8.6               | 8.4       | 1.9    |
| sorcerer-bar   | 17.3              | 18.6              | 17.9      | 3.6    |
| sorcerer-mend  | 18.1              | 20.1              | 19.1      | 3.4    |

## What the table says, and what it does not

- **The 200-0 mirror is gone.** Mended warrior vs plain warrior is 88 %, not 100 %, and the plain
  warrior still wins 12 %. Within the warrior family, a build with more skills still beats the plain
  one, and Mend adds little (bar 86 %, mend 88 %). Intra-class variety is weak.
- **Classes are not balanced.** The gap is between classes, not builds. Warriors win 74 % to 89 %
  overall, rogues sit near 40 % to 51 %, and sorcerers near 8 % to 19 %. The arena takes its numbers
  from classic hero stats, which give a level-1 warrior 125 hp and armor 8, a rogue 88 hp and armor
  13, and a sorcerer 60 hp and armor 5. In a development run before the 1.1.0 rules, a sorcerer
  given the warrior's 125 hp still lost 99 of 100 fights, so hp alone does not explain the gap. The sorcerer's
  output is low too: arena spell power is a percent of weapon damage, and the classic sorcerer's
  magic scaling is not in it.
- **Mend's value is small.** Halving the heal changed the warrior-mend row by under 2 points, so
  the heal is not a dominant strategy. The dominance is the class gap.

## Open follow-ups

- **Class stat parity (classic content).** Fixing the warrior, rogue and sorcerer gap is a classic
  balance pass: hp and armor by class, and how spell damage scales with magic in the arena build.
  It changes classic hero numbers, so it needs its own design note. NEED Q-ARENA-1: change classic
  class numbers, or normalise arena builds per class? | options: 1) classic stat pass (recommended,
  one source of truth) 2) per-class arena normalisation (keeps classic untouched, adds an arena-only
  rule) 3) accept the gap | DECIDED: 1, not done in this change.
- **Caster spell scaling.** `classicArenaBuild` could fold magic into spell power. That also touches
  the classic build pins.
