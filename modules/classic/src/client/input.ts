/**
 * Input bindings of the classic client (docs/design/classic.md §12.4). The
 * key map, mode cycling and speed steps are pure functions. PointerInput is a
 * small state machine over renderer PointerInfo events (tap, hold, move, up)
 * with a hold-repeat timer driven by update(dtMs), so tests need no DOM.
 * bindKeyboard() is the only DOM code (window keydown).
 */
import type { Entity } from "@gamez/kernel";
import type { PointerInfo } from "@gamez/ui-host";
import type { ControlMode, SimSpeed } from "../resources.ts";
import { SUB } from "../fixed.ts";
import { ACTION } from "../actions.ts";
import type { PanelId, PartyMemberView, PartyView } from "./contract.ts";

export type KeyCommand =
  | { kind: "cast"; slot: number }
  | { kind: "drink"; slot: number }
  | { kind: "panel"; panel: PanelId }
  | { kind: "closeAll" }
  | { kind: "portal" }
  | { kind: "cycleMode" }
  | { kind: "speed"; delta: 1 | -1 }
  | { kind: "minimap" }
  | { kind: "automap" }
  /** F1-F4: take control of the party member in slot `slot` (0..3). */
  | { kind: "control"; slot: number }
  /** Tab / Shift+Tab with a party of two or more: the next / previous member. */
  | { kind: "cycleControl"; delta: 1 | -1 };

/** Context of a keypress that changes meaning with the party (Tab) and Shift. */
export interface KeyContext {
  shift?: boolean;
  /** Party size (1 = solo: Tab keeps the automap). */
  partySize?: number;
}

/** Panel keys (letters are case-insensitive). N = talents, Y = achievements (wave A; no clash with the bindings below). */
const PANEL_KEYS: Readonly<Record<string, PanelId>> = {
  c: "character",
  i: "inventory",
  s: "skills",
  l: "quests",
  n: "talents",
  y: "achievements",
  // Wave C: the bank (K = keep; B, G and the other social letters stay free for wave B's planned keys).
  k: "bank",
  // Party roster (docs/design/party.md §10.4).
  p: "party",
};
const DRINK_KEYS: Readonly<Record<string, number>> = { q: 0, w: 1, e: 2, r: 3 };

/** F1..F4 -> party slot 0..3. */
const CONTROL_KEYS: Readonly<Record<string, number>> = { F1: 0, F2: 1, F3: 2, F4: 3 };

/**
 * The command bound to a KeyboardEvent.key value, or null. Letters are case-insensitive.
 * Tab cycles control with a party of two or more (Shift+Tab backwards); solo, Tab is the
 * automap. The backquote key always toggles the automap.
 */
export function keyCommand(key: string, ctx: KeyContext = {}): KeyCommand | null {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k >= "1" && k <= "6" && k.length === 1) return { kind: "cast", slot: Number(k) - 1 };
  if (k in DRINK_KEYS) return { kind: "drink", slot: DRINK_KEYS[k]! };
  if (k in PANEL_KEYS) return { kind: "panel", panel: PANEL_KEYS[k]! };
  if (k in CONTROL_KEYS) return { kind: "control", slot: CONTROL_KEYS[k]! };
  switch (k) {
    case "Escape":
      return { kind: "closeAll" };
    case "m":
      return { kind: "minimap" };
    case "Tab":
      if ((ctx.partySize ?? 1) >= 2) return { kind: "cycleControl", delta: ctx.shift ? -1 : 1 };
      return { kind: "automap" };
    case "`":
    case "Backquote":
      return { kind: "automap" };
    case "t":
      return { kind: "portal" };
    case " ":
    case "Spacebar":
      return { kind: "cycleMode" };
    case "+":
    case "=":
      return { kind: "speed", delta: 1 };
    case "-":
    case "_":
      return { kind: "speed", delta: -1 };
    default:
      return null;
  }
}

/** Manual -> Auto -> Full Idle -> Manual. */
export function nextMode(mode: ControlMode): ControlMode {
  return mode === "manual" ? "auto" : mode === "auto" ? "idle" : "manual";
}

export const SPEEDS: readonly SimSpeed[] = [1, 2, 4, 8];

/** The next idle speed up (+1) or down (-1), clamped to 1..8. */
export function stepSpeed(speed: SimSpeed, delta: 1 | -1): SimSpeed {
  const i = SPEEDS.indexOf(speed);
  const at = i < 0 ? 0 : i;
  const next = Math.min(SPEEDS.length - 1, Math.max(0, at + delta));
  return SPEEDS[next]!;
}

/** True for form fields and editable content: keys belong to the text there. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const t = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

/** The action a frame click or F-key on a party member sends (see memberCall). */
export type MemberCall =
  | { name: string; payload: { hero: number } }
  | { name: string; payload: { target: number } };

/**
 * What picking party member `m` (frame click, F1..F4) does (docs/design/party.md §10.4):
 * a standing member takes control; a DOWNED member is never given control (a corpse cannot act),
 * the controlled hero walks over and revives it instead (classic.interact, as a tap on the body
 * in the world). Null for the controlled member, or for a downed one while the controlled hero
 * is down too.
 */
export function memberCall(
  m: PartyMemberView,
  members: readonly PartyMemberView[],
): MemberCall | null {
  if (m.controlled) return null;
  if (m.dead) {
    const self = members.find((x) => x.controlled);
    if (!self || self.dead) return null;
    return { name: ACTION.interact, payload: { target: m.entity } };
  }
  return { name: ACTION.partyControl, payload: { hero: m.entity } };
}

/**
 * Party control for a key command (docs/design/party.md §10.4), as the action to send: F1..F4 pick
 * a member (memberCall: control, or revive a downed one) and Tab/Shift+Tab take control of the next
 * standing member. Null when the command is not a party command, the target is missing or already
 * controlled, or there is no party of two or more for Tab.
 */
export function partyKeyCall(cmd: KeyCommand, party: PartyView | null): MemberCall | null {
  if (!party) return null;
  const members = party.members;
  if (cmd.kind === "control") {
    const m = members[cmd.slot];
    return m ? memberCall(m, members) : null;
  }
  if (cmd.kind === "cycleControl") {
    const n = members.length;
    if (n < 2) return null;
    const at = members.findIndex((m) => m.controlled);
    const from = at < 0 ? 0 : at;
    // Downed members are skipped: Tab only ever hands control to a standing hero.
    for (let i = 1; i < n; i++) {
      const next = members[(from + cmd.delta * i + n * n) % n];
      if (next && !next.controlled && !next.dead)
        return { name: ACTION.partyControl, payload: { hero: next.entity } };
    }
    return null;
  }
  return null;
}

/**
 * Keydown listener on `win` that forwards bound keys (no Ctrl/Meta/Alt, not while typing). Returns the
 * unbind function. `partySize` (optional) tells Tab whether the party has two or more members.
 */
export function bindKeyboard(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  onKey: (cmd: KeyCommand) => void,
  partySize?: () => number,
): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const cmd = keyCommand(e.key, { shift: e.shiftKey, partySize: partySize?.() ?? 1 });
    if (cmd === null) return;
    e.preventDefault();
    onKey(cmd);
  };
  win.addEventListener("keydown", listener as EventListener);
  return () => win.removeEventListener("keydown", listener as EventListener);
}

/**
 * A left tap that no sim entity took (no unit, loot or interactable under it).
 * Returns true when it consumed the tap, so the pointer does not walk the hero
 * there. Town presence uses this for remote avatars and shopkeeper ghosts, which
 * are renderer entities, not sim entities.
 */
export type TapInterceptor = (p: PointerInfo) => boolean;

const tapInterceptors: TapInterceptor[] = [];

/** Registers a tap interceptor (per page). Returns the function that removes it. */
export function addTapInterceptor(fn: TapInterceptor): () => void {
  tapInterceptors.push(fn);
  return () => {
    const i = tapInterceptors.indexOf(fn);
    if (i >= 0) tapInterceptors.splice(i, 1);
  };
}

/** Runs the interceptors in registration order until one consumes the tap. */
export function interceptTap(p: PointerInfo): boolean {
  for (const fn of tapInterceptors) if (fn(p)) return true;
  return false;
}

/** What the pointer asked for. Tile coordinates are integers; `x`/`y` of casts are sub units. */
export type PointerCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "attack"; entity: Entity; repeat: boolean }
  | {
      kind: "cast";
      slot: number;
      entity: Entity;
      x: number;
      y: number;
      repeat: boolean;
      stand: boolean;
    }
  | { kind: "pickup"; entity: Entity }
  | { kind: "interact"; entity: Entity };

/** What is under a fractional tile position (see SceneSync.pickAt). */
export interface PointerPick {
  /** "ally": a downed party member (scene.ts PickKind); taps on it interact (revive). */
  kind: "unit" | "loot" | "npc" | "interactable" | "ally";
  entity: Entity;
}

export interface PointerEnv {
  /** Entity under a fractional tile position (within reach), or null. */
  pick(x: number, y: number): PointerPick | null;
}

/** Hold-to-move / hold-to-attack repeat period (ms). */
export const HOLD_REPEAT_MS = 250;

/**
 * Pointer state machine. Left tap: attack monster / pick loot / interact with
 * NPC or stairs / walk. Shift+tap: stand and cast slot 1 at the point. Right
 * tap: cast slot 2 at the monster or point. Hold (left): repeat every 250 ms
 * (walk toward the pointer, or keep attacking the monster under it).
 */
export class PointerInput {
  private held: { x: number; y: number } | null = null;
  private heldMs = 0;
  private hoverEntity: Entity = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly env: PointerEnv,
    private readonly emit: (cmd: PointerCommand) => void,
    private readonly onHover: (entity: Entity, x: number, y: number) => void = () => {},
    private readonly repeatMs = HOLD_REPEAT_MS,
  ) {}

  /** Processes one renderer pointer event. */
  handle(p: PointerInfo): void {
    this.lastX = p.x;
    this.lastY = p.y;
    switch (p.kind) {
      case "move": {
        if (this.held) this.held = { x: p.x, y: p.y };
        const hit = this.env.pick(p.x, p.y);
        const entity = hit?.kind === "unit" ? hit.entity : 0;
        if (entity !== this.hoverEntity) {
          this.hoverEntity = entity;
          this.onHover(entity, p.x, p.y);
        }
        return;
      }
      case "tap":
        this.tap(p);
        return;
      case "hold":
        if (p.button !== 0 || this.held) return;
        this.held = { x: p.x, y: p.y };
        this.heldMs = 0;
        this.groundOrAttack(p.x, p.y);
        return;
      case "up":
        this.held = null;
        this.heldMs = 0;
        return;
      default:
        return;
    }
  }

  /** Advances the hold timer; re-issues the held command every repeatMs. */
  update(dtMs: number): void {
    if (!this.held) return;
    this.heldMs += Math.max(0, dtMs);
    while (this.heldMs >= this.repeatMs) {
      this.heldMs -= this.repeatMs;
      if (!this.held) return;
      this.groundOrAttack(this.held.x, this.held.y);
    }
  }

  /** True while a left-button hold is active. */
  get holding(): boolean {
    return this.held !== null;
  }

  /** Monster currently under the pointer (0 = none). */
  get hovered(): Entity {
    return this.hoverEntity;
  }

  /** Last pointer position in fractional tiles. */
  get pointer(): { x: number; y: number } {
    return { x: this.lastX, y: this.lastY };
  }

  /** Clears a hold (panel opened, mode switched, unmount). */
  cancel(): void {
    this.held = null;
    this.heldMs = 0;
  }

  private tap(p: PointerInfo): void {
    const hit = this.env.pick(p.x, p.y);
    const point = { x: Math.round(p.x * SUB), y: Math.round(p.y * SUB) };
    if (p.button === 2) {
      const entity = hit?.kind === "unit" ? hit.entity : 0;
      this.emit({
        kind: "cast",
        slot: 1,
        entity,
        x: point.x,
        y: point.y,
        repeat: false,
        stand: false,
      });
      return;
    }
    if (p.button !== 0) return;
    if (p.shift) {
      this.emit({
        kind: "cast",
        slot: 0,
        entity: 0,
        x: point.x,
        y: point.y,
        repeat: false,
        stand: true,
      });
      return;
    }
    if (!hit && interceptTap(p)) return;
    if (!hit) {
      this.emit({ kind: "move", x: Math.floor(p.x), y: Math.floor(p.y) });
      return;
    }
    if (hit.kind === "unit") this.emit({ kind: "attack", entity: hit.entity, repeat: true });
    else if (hit.kind === "loot") this.emit({ kind: "pickup", entity: hit.entity });
    else this.emit({ kind: "interact", entity: hit.entity });
  }

  private groundOrAttack(x: number, y: number): void {
    const hit = this.env.pick(x, y);
    if (hit?.kind === "unit") {
      this.emit({ kind: "attack", entity: hit.entity, repeat: true });
      return;
    }
    this.emit({ kind: "move", x: Math.floor(x), y: Math.floor(y) });
  }
}
