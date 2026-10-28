/**
 * Pure view model for the duel screen: turns the instance world and registry
 * into plain data for the React components, and events into log lines.
 * No React here, so it can be tested directly.
 */
import type { Entity, FrozenRegistry, GameEvent, World } from "@gamez/kernel";
import { xpToNext } from "../combat.ts";
import { teamOf } from "../team.ts";
import {
  BATTLE,
  Mon,
  type BattlePhase,
  type BattleResult,
  type BattleState,
  type CreatureDef,
  type ElementDef,
  type MonState,
  type MoveDef,
} from "../schema.ts";

export interface MoveView {
  id: string;
  name: string;
  element: string;
  elementName: string;
  power: number;
  accuracy: number;
  pp: number;
  maxPp: number;
  drain: number;
}

export interface MonView {
  entity: Entity;
  side: "player" | "wild";
  name: string;
  blurb: string;
  element: string;
  elementName: string;
  level: number;
  xp: number;
  xpNext: number;
  hp: number;
  maxHp: number;
  fainted: boolean;
  slot: number;
  team: boolean;
  moves: MoveView[];
}

export interface BattleView {
  phase: BattlePhase;
  result: BattleResult | null;
  turn: number;
  battles: number;
  lead: MonView | null;
  wild: MonView | null;
  /** Team members in slot order (alive or not). */
  team: MonView[];
  box: MonView[];
  /** Player-visible status line for the current phase. */
  status: string;
  canMove: boolean;
  canSwitch: boolean;
  canCapture: boolean;
  canFlee: boolean;
  canHeal: boolean;
  canNext: boolean;
}

function elementName(reg: FrozenRegistry, id: string): string {
  return reg.get<ElementDef>("duel.element", id)?.name ?? id;
}

function monView(
  world: World,
  reg: FrozenRegistry,
  entity: Entity,
  side: "player" | "wild",
): MonView | null {
  const m: MonState | undefined = world.get(entity, Mon);
  if (m === undefined) return null;
  const species = reg.require<CreatureDef>("duel.creature", m.species);
  const moves: MoveView[] = species.moves.map((id, i) => {
    const move = reg.require<MoveDef>("duel.move", id);
    return {
      id,
      name: move.name,
      element: move.element,
      elementName: elementName(reg, move.element),
      power: move.power,
      accuracy: move.accuracy,
      pp: m.pp[i] ?? 0,
      maxPp: move.pp,
      drain: move.drain,
    };
  });
  return {
    entity,
    side,
    name: species.name,
    blurb: species.blurb,
    element: species.element,
    elementName: elementName(reg, species.element),
    level: m.level,
    xp: m.xp,
    xpNext: xpToNext(m.level),
    hp: m.hp,
    maxHp: m.maxHp,
    fainted: m.hp <= 0,
    slot: m.slot,
    team: m.team,
    moves,
  };
}

function statusFor(b: BattleState, lead: MonView | null, wild: MonView | null): string {
  switch (b.phase) {
    case "choose":
      return `Turn ${b.turn + 1}: choose a move, switch, capture or flee.`;
    case "switch":
      return `${lead?.name ?? "Your creature"} fainted. Send out another creature.`;
    case "ended":
      switch (b.result) {
        case "won":
          return `${wild?.name ?? "The wild creature"} is defeated!`;
        case "captured":
          return `${wild?.name ?? "The wild creature"} joined your team.`;
        case "fled":
          return "You got away.";
        case "lost":
          return "All your creatures fainted. Heal before the next battle.";
        default:
          return "Battle over.";
      }
  }
}

/** Builds the screen model from the instance world; null when no battle state exists yet. */
export function buildBattleView(world: World, reg: FrozenRegistry): BattleView | null {
  const b = world.getResource<BattleState>(BATTLE);
  if (!b) return null;
  const lead = b.playerMon === null ? null : monView(world, reg, b.playerMon, "player");
  const wild = b.wildMon === null ? null : monView(world, reg, b.wildMon, "wild");
  const team = teamOf(world)
    .map((e) => monView(world, reg, e, "player"))
    .filter((v): v is MonView => v !== null);
  const box = world
    .query(Mon)
    .filter((e) => {
      const m = world.read(e, Mon);
      return m.owner === "player" && !m.team;
    })
    .map((e) => monView(world, reg, e, "player"))
    .filter((v): v is MonView => v !== null);
  const choosing = b.phase === "choose";
  const hasSwitchTarget = team.some((t) => !t.fainted && t.entity !== b.playerMon);
  const aliveCount = team.filter((t) => !t.fainted).length;
  return {
    phase: b.phase,
    result: b.result,
    turn: b.turn,
    battles: b.battles,
    lead,
    wild,
    team,
    box,
    status: statusFor(b, lead, wild),
    canMove: choosing,
    canSwitch: (choosing || b.phase === "switch") && hasSwitchTarget,
    canCapture: choosing && wild !== null,
    canFlee: choosing,
    canHeal: b.phase === "ended",
    canNext: b.phase === "ended" && aliveCount > 0,
  };
}

function num(e: GameEvent, key: string): number {
  const v = e[key];
  return typeof v === "number" ? v : 0;
}

function str(e: GameEvent, key: string): string {
  const v = e[key];
  return typeof v === "string" ? v : "";
}

const BATTLE_RESULT_LINES: Record<string, string> = {
  won: "You won the battle!",
  captured: "Capture complete.",
  fled: "The battle ended.",
  lost: "Your whole team fainted.",
};

/** A short log line for one event; null for events that need no line. */
export function describeEvent(e: GameEvent): string | null {
  switch (e.type) {
    case "duel.battleStarted":
      return `A wild ${str(e, "name")} (Lv ${num(e, "level")}) appeared!`;
    case "duel.turn":
      return `Turn ${num(e, "turn")}`;
    case "duel.moveUsed":
      return `${e.side === "wild" ? "Wild " : ""}${str(e, "name")} used ${str(e, "move")}!`;
    case "duel.missed":
      return `${str(e, "name")}'s attack missed.`;
    case "duel.effectiveness":
      return num(e, "multiplier") > 100 ? "It's super effective!" : "It's not very effective.";
    case "duel.damage":
      return `${str(e, "name")} took ${num(e, "amount")} damage (${num(e, "hp")}/${num(e, "maxHp")} HP).`;
    case "duel.drained":
      return `${str(e, "name")} drained ${num(e, "amount")} HP.`;
    case "duel.noMoves":
      return `Wild ${str(e, "name")} has no moves left.`;
    case "duel.fainted":
      return `${str(e, "name")} fainted!`;
    case "duel.switchRequired":
      return "Choose the next creature to send out.";
    case "duel.switched":
      return `Go, ${str(e, "name")}!`;
    case "duel.captureFailed":
      return `${str(e, "name")} broke free of the capture!`;
    case "duel.captured":
      return `Caught ${str(e, "name")}! It went to ${e.box === true ? "the box" : "your team"}.`;
    case "duel.fled":
      return "Got away safely!";
    case "duel.fleeFailed":
      return "Couldn't get away!";
    case "duel.xpGained":
      return `${str(e, "name")} gained ${num(e, "amount")} XP.`;
    case "duel.levelUp":
      return `${str(e, "name")} grew to level ${num(e, "level")}!`;
    case "duel.healed":
      return `Your team is healed (${num(e, "count")} creatures).`;
    case "duel.battleEnded":
      return BATTLE_RESULT_LINES[str(e, "result")] ?? null;
    default:
      return null;
  }
}
