/**
 * QA introspection for the Pixi renderer (tools/qa, `?debug=1`). Nothing here
 * runs until the renderer's debug is enabled, except the one-off "missing id"
 * bookkeeping of the sprite cache. Pure (no Pixi), so it is unit-testable.
 */
import type { EntityAction, EntityKind, Facing, ResolutionKind } from "@gamez/ui-host";
import { appearanceCandidates } from "./appearance.ts";

/** Frames kept for the frame-time window. */
const WINDOW = 240;

/** True when `?debug=1` (or `debug=true`) is in the page URL. Read once per renderer. */
export function debugRequested(): boolean {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? "").get("debug");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

/**
 * Classifies a resolved key for an appearance (see ResolutionKind). `key` is
 * null when nothing resolved and the entity is drawn as a primitive. Loot,
 * projectiles and props are single sprites, so the bare appearance is exact
 * for them whatever the action.
 */
export function classifyResolution(
  appearance: string,
  action: EntityAction,
  facing: Facing,
  key: string | null,
  kind: EntityKind = "unit",
): ResolutionKind {
  if (key === null) return "primitive";
  if (!appearanceCandidates(appearance, action, facing).includes(key)) return "fallback";
  const animated = kind === "unit" || kind === "npc";
  if (
    key === `${appearance}.${action}.${facing}` ||
    key === `${appearance}.${action}` ||
    (key === appearance && (action === "idle" || !animated))
  ) {
    return "exact";
  }
  if (key === appearance || key.startsWith(`${appearance}.`)) return "action-fallback";
  return "generic";
}

function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** Average and 95th percentile of the first `n` values of a ring buffer. */
export function windowStats(
  buf: Float32Array,
  n: number,
): { avg: number; p95: number; max: number } {
  if (n <= 0) return { avg: 0, p95: 0, max: 0 };
  const vals = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
  let sum = 0;
  for (const v of vals) sum += v;
  const p95 = vals[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
  return { avg: round(sum / n), p95: round(p95), max: round(vals[n - 1] ?? 0) };
}

/** Counters and "seen" tables filled by the renderer while debug is enabled. */
export class DebugTracker {
  private readonly frames = new Float32Array(WINDOW);
  private readonly ticks = new Float32Array(WINDOW);
  private count = 0;
  private next = 0;
  chunksBuilt = 0;
  effectsPlayed = 0;
  floatsShown = 0;
  /** "appearance|action|facing" -> "key (kind)". */
  readonly anims = new Map<string, string>();
  /** "kind|sprite" -> "sprite" | "procedural". */
  readonly effects = new Map<string, string>();
  /** Entity appearances that did not resolve to their own art. */
  readonly entityMissing = new Set<string>();

  frame(dtMs: number, tickMs: number): void {
    this.frames[this.next] = dtMs;
    this.ticks[this.next] = tickMs;
    this.next = (this.next + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
  }

  frameMs(): { avg: number; p95: number; max: number } {
    return windowStats(this.frames, this.count);
  }

  tickMs(): { avg: number; p95: number } {
    const s = windowStats(this.ticks, this.count);
    return { avg: s.avg, p95: s.p95 };
  }

  /** Records one entity resolution (called only when the resolved key changes). */
  resolved(
    appearance: string,
    action: EntityAction,
    facing: Facing,
    fallback: string,
    key: string | null,
    entityKind: EntityKind = "unit",
  ): void {
    const kind = classifyResolution(appearance, action, facing, key, entityKind);
    this.anims.set(`${appearance}|${action}|${facing}`, `${key ?? "primitive"} (${kind})`);
    if (kind === "primitive" || kind === "fallback" || kind === "generic") {
      this.entityMissing.add(appearance || fallback || "(empty)");
    }
  }

  effect(kind: string, sprite: string | undefined, hasSprite: boolean): void {
    this.effectsPlayed++;
    this.effects.set(`${kind}|${sprite ?? ""}`, hasSprite ? "sprite" : "procedural");
  }
}

/** Sorted plain-object copy of a string map (JSON-friendly, stable order). */
export function sortedRecord(m: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) ?? "";
  return out;
}
