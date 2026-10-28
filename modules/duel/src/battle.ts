/**
 * duel.battle: the battle state machine ("duel.battle" resource) and the
 * player's commands: move, switch, capture, flee and the next battle.
 *
 * Phases: choose (a command is due), switch (the lead fainted, a replacement
 * is due), ended (no battle; the player may heal and start the next one).
 * Each command resolves its turn, then duel.ai plans the wild move, then the
 * outcome system ends the battle or asks for a switch.
 */
import { ActionError, defineModule, type Entity, type SimContext, type World } from "@gamez/kernel";
import { gainXp, moveSlot, newMon, pickUsableMove, speciesOf, statAt, strike } from "./combat.ts";
import { aliveTeam, boxCount, teamOf, teamSlot } from "./team.ts";
import {
  BATTLE,
  CAPTURE_BONUS,
  FLEE_CHANCE,
  MAX_LEVEL,
  Mon,
  TEAM_SIZE,
  type BattleResult,
  type BattleState,
  type CreatureDef,
} from "./schema.ts";

/** XP per level of the defeated wild creature. */
const WIN_XP_PER_LEVEL = 6;

function battleOf(world: World): BattleState {
  const b = world.getResource<BattleState>(BATTLE);
  if (!b) throw new Error("duel: battle state missing");
  return b;
}

/** The two active creatures; only valid while a battle is running. */
function fighters(b: BattleState): { me: Entity; wild: Entity } {
  if (b.playerMon === null || b.wildMon === null) throw new Error("duel: battle without fighters");
  return { me: b.playerMon, wild: b.wildMon };
}

/** A command is only accepted while the player is choosing. */
function requireChoose(world: World): BattleState {
  const b = battleOf(world);
  if (b.phase === "ended") throw new ActionError("no_battle", "no battle in progress");
  if (b.phase === "switch") throw new ActionError("must_switch", "send out a creature first");
  return b;
}

function endBattle(ctx: SimContext, b: BattleState, result: BattleResult): void {
  b.phase = "ended";
  b.result = result;
  ctx.emit({ type: "duel.battleEnded", result });
}

/** The wild creature attacks with its planned move. */
function wildTurn(world: World, ctx: SimContext, b: BattleState): void {
  const { me, wild } = fighters(b);
  if (b.wildMove === null) {
    const name = speciesOf(ctx.registry, world.read(wild, Mon)).name;
    ctx.emit({ type: "duel.noMoves", side: "wild", mon: wild, name });
    return;
  }
  strike(world, ctx, wild, me, b.wildMove);
}

/** Starts a wild battle against a random creature, led by the first healthy team member. */
function startBattle(world: World, ctx: SimContext, battles: number): void {
  for (const e of world.query(Mon)) {
    if (world.read(e, Mon).owner === "wild") world.destroy(e);
  }
  const alive = aliveTeam(world);
  const lead = alive[0];
  if (lead === undefined) throw new ActionError("no_fit_creature", "heal the team first");
  const top = Math.max(...alive.map((e) => world.read(e, Mon).level));
  const ids = ctx.registry.all<CreatureDef>("duel.creature").map(([id]) => id);
  const speciesId = ctx.rng.pick(ids);
  const level = Math.min(MAX_LEVEL, Math.max(2, top + ctx.rng.int(-1, 1)));
  const wild = newMon(world, ctx, speciesId, level, "wild", false, 0);
  const wildMove = pickUsableMove(world, ctx, wild);
  world.setResource<BattleState>(BATTLE, {
    phase: "choose",
    turn: 0,
    playerMon: lead,
    wildMon: wild,
    result: null,
    battles,
    wildMove,
    wildPlanned: true,
  });
  const species = speciesOf(ctx.registry, world.read(wild, Mon));
  const leadName = speciesOf(ctx.registry, world.read(lead, Mon)).name;
  ctx.emit({ type: "duel.battleStarted", wild, name: species.name, level, lead, leadName });
}

export default defineModule({
  id: "duel.battle",
  version: "1.0.0",
  deps: ["duel.creatures", "duel.team"],
  setup(world, ctx) {
    startBattle(world, ctx, 1);
  },
  actions: [
    {
      name: "duel.useMove",
      parse(_world, payload) {
        const moveId =
          typeof payload === "object" && payload !== null
            ? (payload as { moveId?: unknown }).moveId
            : undefined;
        if (typeof moveId !== "string" || moveId === "") {
          throw new ActionError("bad_payload", "moveId must be a non-empty string");
        }
        return { moveId };
      },
      apply(world, { moveId }, ctx) {
        const b = requireChoose(world);
        const { me, wild } = fighters(b);
        const mine = world.read(me, Mon);
        const theirs = world.read(wild, Mon);
        const mySpecies = speciesOf(ctx.registry, mine);
        const idx = moveSlot(ctx.registry, mine, moveId);
        if (idx === null) {
          throw new ActionError("unknown_move", `${mySpecies.name} does not know ${moveId}`);
        }
        if ((mine.pp[idx] ?? 0) <= 0) throw new ActionError("no_pp", `${moveId} has no PP left`);

        b.turn += 1;
        ctx.emit({ type: "duel.turn", turn: b.turn });
        // Faster creature goes first; equal speed favours the player.
        const wildFirst =
          statAt(speciesOf(ctx.registry, theirs).stats.spd, theirs.level) >
          statAt(mySpecies.stats.spd, mine.level);
        if (wildFirst) {
          wildTurn(world, ctx, b);
          if (mine.hp > 0 && theirs.hp > 0) strike(world, ctx, me, wild, moveId);
        } else {
          strike(world, ctx, me, wild, moveId);
          if (mine.hp > 0 && theirs.hp > 0) wildTurn(world, ctx, b);
        }
        b.wildPlanned = false;
      },
    },
    {
      name: "duel.switch",
      parse(_world, payload) {
        const slot =
          typeof payload === "object" && payload !== null
            ? (payload as { slot?: unknown }).slot
            : undefined;
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= TEAM_SIZE) {
          throw new ActionError("bad_payload", `slot must be an integer 0..${TEAM_SIZE - 1}`);
        }
        return { slot };
      },
      apply(world, { slot }, ctx) {
        const b = battleOf(world);
        if (b.phase === "ended") throw new ActionError("no_battle", "no battle in progress");
        const target = teamSlot(world, slot);
        if (target === undefined) throw new ActionError("bad_target", "no creature in that slot");
        if (target === b.playerMon) throw new ActionError("already_active", "already in battle");
        const m = world.read(target, Mon);
        if (m.hp <= 0) throw new ActionError("fainted", "that creature has fainted");

        const wasChoosing = b.phase === "choose";
        b.playerMon = target;
        b.phase = "choose";
        ctx.emit({
          type: "duel.switched",
          side: "player",
          mon: target,
          name: speciesOf(ctx.registry, m).name,
        });
        // A voluntary switch costs the turn: the wild creature attacks the newcomer.
        // A forced switch after a faint does not.
        if (wasChoosing) {
          b.turn += 1;
          ctx.emit({ type: "duel.turn", turn: b.turn });
          wildTurn(world, ctx, b);
          b.wildPlanned = false;
        }
      },
    },
    {
      name: "duel.capture",
      parse() {
        return null;
      },
      apply(world, _payload, ctx) {
        const b = requireChoose(world);
        const { wild } = fighters(b);
        const target = world.read(wild, Mon);
        const species = speciesOf(ctx.registry, target);
        b.turn += 1;
        ctx.emit({ type: "duel.turn", turn: b.turn });

        // Lower HP makes the wild creature easier to catch.
        const catchValue = Math.min(
          255,
          Math.floor(
            (species.captureRate * (3 * target.maxHp - 2 * target.hp)) / (3 * target.maxHp),
          ) + CAPTURE_BONUS,
        );
        if (ctx.rng.int(1, 255) <= catchValue) {
          const teamCount = teamOf(world).length;
          if (teamCount < TEAM_SIZE) {
            target.team = true;
            target.slot = teamCount;
          } else {
            target.team = false;
            target.slot = boxCount(world);
          }
          target.owner = "player";
          ctx.emit({ type: "duel.captured", mon: wild, name: species.name, box: !target.team });
          endBattle(ctx, b, "captured");
        } else {
          ctx.emit({ type: "duel.captureFailed", mon: wild, name: species.name, catchValue });
          wildTurn(world, ctx, b);
          b.wildPlanned = false;
        }
      },
    },
    {
      name: "duel.flee",
      parse() {
        return null;
      },
      apply(world, _payload, ctx) {
        const b = requireChoose(world);
        b.turn += 1;
        ctx.emit({ type: "duel.turn", turn: b.turn });
        if (ctx.rng.chance(FLEE_CHANCE)) {
          ctx.emit({ type: "duel.fled" });
          endBattle(ctx, b, "fled");
        } else {
          ctx.emit({ type: "duel.fleeFailed" });
          wildTurn(world, ctx, b);
          b.wildPlanned = false;
        }
      },
    },
    {
      name: "duel.nextBattle",
      parse() {
        return null;
      },
      apply(world, _payload, ctx) {
        const b = battleOf(world);
        if (b.phase !== "ended")
          throw new ActionError("battle_active", "finish the current battle first");
        startBattle(world, ctx, b.battles + 1);
      },
    },
  ],
  systems: [
    {
      // Runs after every action: decides how the battle moves on.
      id: "duel.battle.outcome",
      stage: "post",
      run(world, ctx) {
        const b = battleOf(world);
        if (b.phase === "ended") return;
        const { me, wild } = fighters(b);
        const wildMon = world.read(wild, Mon);
        if (wildMon.hp <= 0) {
          gainXp(world, ctx, me, wildMon.level * WIN_XP_PER_LEVEL);
          endBattle(ctx, b, "won");
          return;
        }
        if (b.phase === "switch" || world.read(me, Mon).hp > 0) return;
        if (aliveTeam(world).length > 0) {
          b.phase = "switch";
          ctx.emit({
            type: "duel.switchRequired",
            mon: me,
            name: speciesOf(ctx.registry, world.read(me, Mon)).name,
          });
        } else {
          endBattle(ctx, b, "lost");
        }
      },
    },
  ],
});
