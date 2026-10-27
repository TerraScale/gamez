/**
 * Duel schema: component and resource keys, prototype shapes and the
 * tuning constants shared by the duel modules and the client view.
 */
import { defineComponent, type Entity } from "@gamez/kernel";

/** Data prototype shapes (registry kinds "duel.element", "duel.move", "duel.creature"). */
export interface ElementDef {
  name: string;
  /** Attacks of this element hit these elements for 150%. */
  strong: string[];
  /** Attacks of this element hit these elements for 50%. */
  weak: string[];
}

export interface MoveDef {
  name: string;
  element: string;
  power: number;
  /** Percent chance to hit, 1..100. */
  accuracy: number;
  /** Uses before the move is spent; restored by duel.heal. */
  pp: number;
  /** Percent of the damage dealt that the user heals (0 for plain moves). */
  drain: number;
}

export interface CreatureStats {
  hp: number;
  atk: number;
  def: number;
  spd: number;
}

export interface CreatureDef {
  name: string;
  blurb: string;
  element: string;
  stats: CreatureStats;
  /** Exactly four move ids. */
  moves: string[];
  /** Base capture rate, 1..255 (higher is easier to catch). */
  captureRate: number;
}

/** A creature instance: a player's team/box member or the wild opponent. */
export interface MonState {
  /** duel.creature prototype id. */
  species: string;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  /** Remaining uses per move slot, aligned with the species' moves. */
  pp: number[];
  owner: "player" | "wild";
  /** True for a team member (slot 0..5), false for a box entry. */
  team: boolean;
  slot: number;
}

export const Mon = defineComponent<MonState>("duel.mon");

export type BattlePhase = "choose" | "switch" | "ended";
export type BattleResult = "won" | "captured" | "fled" | "lost";

/** Battle state machine, stored as the "duel.battle" resource. */
export interface BattleState {
  /** choose: a command is due. switch: the lead fainted, a replacement is due. ended: no battle. */
  phase: BattlePhase;
  /** Commands resolved in this battle. */
  turn: number;
  /** The player's active creature. */
  playerMon: Entity | null;
  /** The wild creature (kept after the battle so the UI can show it). */
  wildMon: Entity | null;
  result: BattleResult | null;
  /** Battles started so far, including the current one. */
  battles: number;
  /** Move the wild creature will use on its next turn (duel.ai plans it); null if none usable. */
  wildMove: string | null;
  /** False after a turn consumed the plan, until duel.ai plans the next one. */
  wildPlanned: boolean;
}

export const BATTLE = "duel.battle";

export const TEAM_SIZE = 6;
export const STARTER_COUNT = 3;
export const STARTER_LEVEL = 5;
export const MAX_LEVEL = 20;
/** Added to the capture value (0..255) on top of the HP-based chance. */
export const CAPTURE_BONUS = 12;
/** Chance a flee attempt succeeds. */
export const FLEE_CHANCE = 0.5;
