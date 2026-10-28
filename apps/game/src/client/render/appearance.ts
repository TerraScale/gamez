import type { EntityAction, EntityKind, Facing } from "@gamez/ui-host";

/**
 * Pure animation-key resolution for ARPG entities (no Pixi imports, so it is
 * unit-tested directly). The chain follows the doc comment of
 * `ArpgRenderEntity.action`: for each prefix p of the appearance (a.b.c ->
 * a.b.c, a.b, a) try `${p}.${action}.${facing}`, `${p}.${action}`, the
 * action's stand-ins (cast -> attack), `${p}.idle.${facing}`, `${p}.idle`,
 * `${p}`; then the same for the fallback appearance. The caller decides what
 * "hit" means (animation or static sprite).
 */
export function appearanceCandidates(
  appearance: string,
  action: EntityAction,
  facing: Facing,
  fallbackAppearance?: string,
): string[] {
  const out: string[] = [];
  addChain(out, appearance, action, facing);
  if (fallbackAppearance && fallbackAppearance !== appearance) {
    addChain(out, fallbackAppearance, action, facing);
  }
  return out;
}

/**
 * Clips tried after an action's own clip and before idle. A cast without its
 * own clip swings like an attack, so casters never stand still while casting.
 */
export const ACTION_STAND_INS: Readonly<Record<EntityAction, readonly EntityAction[]>> = {
  idle: [],
  walk: [],
  attack: [],
  cast: ["attack"],
  hit: [],
  death: [],
};

function addChain(out: string[], appearance: string, action: EntityAction, facing: Facing): void {
  const standIns = ACTION_STAND_INS[action];
  let prefix = appearance;
  while (prefix.length > 0) {
    pushUnique(out, `${prefix}.${action}.${facing}`);
    pushUnique(out, `${prefix}.${action}`);
    for (const alt of standIns) {
      pushUnique(out, `${prefix}.${alt}.${facing}`);
      pushUnique(out, `${prefix}.${alt}`);
    }
    pushUnique(out, `${prefix}.idle.${facing}`);
    pushUnique(out, `${prefix}.idle`);
    pushUnique(out, prefix);
    const dot = prefix.lastIndexOf(".");
    if (dot < 0) break;
    prefix = prefix.slice(0, dot);
  }
}

function pushUnique(out: string[], key: string): void {
  if (!out.includes(key)) out.push(key);
}

/** First candidate the lookup accepts (non-null), with the key it matched. */
export function firstMatch<T>(
  candidates: readonly string[],
  lookup: (key: string) => T | null | undefined,
): { key: string; value: T } | null {
  for (const key of candidates) {
    const value = lookup(key);
    if (value !== null && value !== undefined) return { key, value };
  }
  return null;
}

/**
 * The action an entity plays: an explicit `action` wins, then death, then
 * walking vs idle from `moving`.
 */
export function resolveAction(
  action: EntityAction | undefined,
  dead: boolean | undefined,
  moving: boolean,
): EntityAction {
  if (action) return action;
  if (dead) return "death";
  return moving ? "walk" : "idle";
}

/** True when a resolved animation key is a death animation (`x.death` or `x.death.dir`). */
export function isDeathKey(key: string): boolean {
  return /(^|\.)death(\.|$)/.test(key);
}

const FACINGS: ReadonlySet<string> = new Set(["n", "ne", "e", "se", "s", "sw", "w", "nw"]);
const LEFT_FACINGS: ReadonlySet<Facing> = new Set<Facing>(["sw", "w", "nw"]);

/** True when the last segment of a resolved key is one of the 8 facings (`x.walk.ne`). */
export function hasFacingSuffix(key: string): boolean {
  const dot = key.lastIndexOf(".");
  return dot >= 0 && FACINGS.has(key.slice(dot + 1));
}

/**
 * Mirror decision for a body: the base art faces screen-right, so a unit or NPC
 * looking to the screen-left (sw, w, nw) is flipped horizontally, unless the
 * art resolved to a facing-specific clip (it is already drawn that way).
 * Loot, props and projectiles never flip.
 */
export function shouldFlip(key: string, facing: Facing, kind: EntityKind): boolean {
  if (kind !== "unit" && kind !== "npc") return false;
  if (key === "" || hasFacingSuffix(key)) return false;
  return LEFT_FACINGS.has(facing);
}
