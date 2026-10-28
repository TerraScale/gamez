import type { EntityAction, Facing } from "@gamez/ui-host";

/**
 * Pure animation-key resolution for ARPG entities (no Pixi imports, so it is
 * unit-tested directly). The chain follows the doc comment of
 * `ArpgRenderEntity.action`: for each prefix p of the appearance (a.b.c ->
 * a.b.c, a.b, a) try `${p}.${action}.${facing}`, `${p}.${action}`,
 * `${p}.idle.${facing}`, `${p}.idle`, `${p}`; then the same for the fallback
 * appearance. The caller decides what "hit" means (animation or static sprite).
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

function addChain(out: string[], appearance: string, action: EntityAction, facing: Facing): void {
  let prefix = appearance;
  while (prefix.length > 0) {
    pushUnique(out, `${prefix}.${action}.${facing}`);
    pushUnique(out, `${prefix}.${action}`);
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
