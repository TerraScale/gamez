/**
 * Pure client helpers for the arena screens (OWNER: T-arena-sim): the replay
 * plan (re-runs fight() with frames and checks it against the recorded
 * result), the viewer's result, ladder marking and the queue poll step.
 * No React here, so the rules are unit-tested without a DOM.
 */
import { fight, type ArenaFrame } from "../fight.ts";
import type { ArenaMatch, ArenaTicket, ArenaWinner, Party } from "@gamez/protocol";

/** Queue poll interval (ms) and the poll count after which the screen stops waiting. */
export const POLL_MS = 1000;
export const MAX_POLLS = 90;
/** Replay speed: frames per second (the arena runs at 10 Hz). */
export const REPLAY_FPS = 10;

export interface ReplayPlan {
  /** Frames of the re-run fight; empty when the rules changed (result only). */
  frames: ArenaFrame[];
  /** False when the rules changed or the re-run disagrees with the record. */
  faithful: boolean;
  winner: ArenaWinner;
  ticks: number;
  /** Shown under the replay when it is not faithful. */
  note: string | null;
}

/**
 * Builds the replay of a match. The recorded winner and ticks are what the
 * screen reports; the frames are only for watching. A different contentHash
 * means the arena rules changed since the fight: no frames, the record only.
 */
export function planReplay(match: ArenaMatch): ReplayPlan {
  const base = { winner: match.winner, ticks: match.ticks };
  const rerun = fight(match.builds.attacker, match.builds.defender, match.seed, { frames: true });
  if (rerun.contentHash !== match.contentHash) {
    return {
      ...base,
      frames: [],
      faithful: false,
      note: "The arena rules changed since this fight. Showing the recorded result only.",
    };
  }
  const same = rerun.winner === match.winner && rerun.ticks === match.ticks;
  return {
    ...base,
    frames: rerun.frames ?? [],
    faithful: same,
    note: same ? null : "This replay does not match the recorded result. Showing the record.",
  };
}

export type ViewerSide = "attacker" | "defender" | null;

/** Which side the viewer fought on (null when the viewer was not in the fight). */
export function viewerSide(match: ArenaMatch, viewerId: string): ViewerSide {
  if (match.attacker.party.accountId === viewerId) return "attacker";
  if (match.defender.party.accountId === viewerId) return "defender";
  return null;
}

/** Banner text from the viewer's side ("You win", "Spectating" for other viewers). */
export function resultLine(winner: ArenaWinner, side: ViewerSide): string {
  if (winner === "draw") return "Draw";
  if (side === null) return winner === "attacker" ? "Attacker wins" : "Defender wins";
  return winner === side ? "You win" : "You lose";
}

/** Result of a fight from the viewer's side, as the status list shows it. */
export function viewerOutcome(winner: ArenaWinner, side: ViewerSide): "win" | "loss" | "draw" {
  if (winner === "draw" || side === null) return "draw";
  return winner === side ? "win" : "loss";
}

/** Human class name from a class id ("classic.warrior" -> "Warrior"). */
export function classLabel(classId: string): string {
  const last = classId.split(".").pop() ?? classId;
  return last.length > 0 ? last[0]!.toUpperCase() + last.slice(1) : classId;
}

/** Colour per class (dark classic palette). */
export const CLASS_COLOURS: Record<string, string> = {
  "classic.warrior": "#d9b26f",
  "classic.rogue": "#7fbf6a",
  "classic.sorcerer": "#7aa7e0",
};

export function classColour(classId: string): string {
  return CLASS_COLOURS[classId] ?? "#c9c2b0";
}

/** Whether a ladder row belongs to the viewer. */
export function isYou(accountId: string, rowAccountId: string): boolean {
  return accountId.length > 0 && accountId === rowAccountId;
}

export type TicketStep =
  | { kind: "wait" }
  | { kind: "matched"; match: ArenaMatch }
  | { kind: "failed"; reason: string };

/** What the queue poll does with a ticket reply. */
export function ticketStep(ticket: ArenaTicket): TicketStep {
  if (ticket.status === "matched" && ticket.match) return { kind: "matched", match: ticket.match };
  if (ticket.status === "failed") return { kind: "failed", reason: ticket.reason ?? "no_opponent" };
  return { kind: "wait" };
}

/** Human text for a queue failure reason code. */
export function failureText(reason: string): string {
  switch (reason) {
    case "no_build":
    case "not_eligible":
      return "Play classic first, then come back to fight.";
    case "limit":
    case "fights_limit":
      return "You have used today's fights. Come back tomorrow.";
    case "disabled":
      return "The arena is closed right now.";
    case "no_opponent":
      return "No opponent was found. Try again in a moment.";
    default:
      return "The fight could not start. Try again.";
  }
}

/** Opponent of the viewer (the other party). */
export function opponentOf(match: ArenaMatch, viewerId: string): Party {
  return match.attacker.party.accountId === viewerId ? match.defender.party : match.attacker.party;
}

/** Fresh operation id for one logical call (accepted by isOpId: 8..64 of [A-Za-z0-9_-]). */
export function newArenaOpId(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `arena_${Date.now().toString(36)}_${rand}`;
}
