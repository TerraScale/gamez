import { Assets, Spritesheet, type Texture } from "pixi.js";
import { resolveId, type AssetManifest } from "@gamez/assets";

export interface SpriteVisual {
  texture: Texture;
  anchor: { x: number; y: number } | undefined;
}

export interface AnimVisual {
  frames: Texture[];
  anchor: { x: number; y: number } | undefined;
  fps: number;
  loop: boolean;
}

export interface Visuals {
  /** Static sprite for a logical id (with fallback), or null when the art is missing. */
  sprite(id: string): SpriteVisual | null;
  /** Animation for a logical id (with fallback), or null when no frames resolve. */
  animation(id: string): AnimVisual | null;
  /** Like sprite() but only for an exact manifest key (no segment fallback). */
  spriteExact(id: string): SpriteVisual | null;
  /** Like animation() but only for an exact manifest key (no segment fallback). */
  animationExact(id: string): AnimVisual | null;
  /** True when the manifest has this exact animation key. */
  hasExactAnimation(id: string): boolean;
}

/**
 * Loads every atlas in the manifest and returns id lookups. A failed atlas
 * leaves its ids unresolved, so the renderer falls back to primitives.
 * `onMissing` (QA) hears each id, once, that resolves to "missing" or nothing.
 */
export async function loadVisuals(
  manifest: AssetManifest,
  baseUrl: string,
  onMissing?: (id: string) => void,
): Promise<Visuals> {
  const sheets = new Map<string, Spritesheet>();
  await Promise.all(
    manifest.atlases.map(async (atlas) => {
      try {
        const loaded: unknown = await Assets.load(baseUrl + atlas.url);
        if (loaded instanceof Spritesheet) sheets.set(atlas.id, loaded);
        else console.warn(`atlas ${atlas.id} is not a spritesheet`);
      } catch (err) {
        console.warn(`atlas ${atlas.id} failed to load`, err);
      }
    }),
  );

  const sprites = new Map<string, SpriteVisual | null>();
  const anims = new Map<string, AnimVisual | null>();

  const sprite = (id: string): SpriteVisual | null => {
    const cached = sprites.get(id);
    if (cached !== undefined) return cached;
    const key = resolveId(manifest.sprites, id);
    const ref = Object.prototype.hasOwnProperty.call(manifest.sprites, key)
      ? manifest.sprites[key]
      : undefined;
    const texture: Texture | undefined = ref
      ? sheets.get(ref.atlas)?.textures[ref.frame]
      : undefined;
    const v = ref && texture ? { texture, anchor: ref.anchor } : null;
    if (onMissing && id !== "missing" && (v === null || key === "missing")) onMissing(id);
    sprites.set(id, v);
    return v;
  };

  const animation = (id: string): AnimVisual | null => {
    const cached = anims.get(id);
    if (cached !== undefined) return cached;
    const key = resolveId(manifest.animations, id);
    const def = Object.prototype.hasOwnProperty.call(manifest.animations, key)
      ? manifest.animations[key]
      : undefined;
    let v: AnimVisual | null = null;
    if (def) {
      const frames: Texture[] = [];
      let anchor: { x: number; y: number } | undefined;
      for (const frameId of def.frames) {
        const s = sprite(frameId);
        if (!s) continue;
        frames.push(s.texture);
        anchor ??= s.anchor;
      }
      if (frames.length > 0) v = { frames, anchor, fps: def.fps, loop: def.loop ?? true };
    }
    anims.set(id, v);
    return v;
  };

  const has = (table: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(table, key);
  const spriteExact = (id: string): SpriteVisual | null =>
    has(manifest.sprites, id) ? sprite(id) : null;
  const animationExact = (id: string): AnimVisual | null =>
    has(manifest.animations, id) ? animation(id) : null;

  const hasExactAnimation = (id: string): boolean => has(manifest.animations, id);
  return { sprite, animation, spriteExact, animationExact, hasExactAnimation };
}
