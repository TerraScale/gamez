/**
 * Asset manifest: the only place that maps logical ids to real images.
 * Game code and modules reference logical ids ("tile.grass.01",
 * "unit.hero.idle.se") and never file names, so swapping an art pack means
 * shipping a different manifest, not changing code.
 */

export interface AtlasRef {
  id: string;
  /** URL of a TexturePacker/AssetPack-style JSON spritesheet (relative to the manifest). */
  url: string;
}

export interface SpriteRef {
  atlas: string;
  /** Frame name inside the atlas. */
  frame: string;
  /** Normalised anchor; defaults to bottom-centre {x: 0.5, y: 1} for units and props. */
  anchor?: { x: number; y: number };
}

export interface AnimationRef {
  /** Logical sprite ids, in order. */
  frames: string[];
  fps: number;
  loop?: boolean;
}

export interface AssetManifest {
  version: string;
  /** Pack id, e.g. "art.kenney". */
  pack: string;
  atlases: AtlasRef[];
  sprites: Record<string, SpriteRef>;
  animations: Record<string, AnimationRef>;
  /** Licence/attribution per source, required even for CC0. */
  licenses: { source: string; license: string; url?: string; author?: string }[];
}

/**
 * Overlay manifests in order; later packs override earlier ids. This is how a
 * module or a future PixelLab pack replaces sprites.
 */
export function mergeManifests(...manifests: AssetManifest[]): AssetManifest {
  const out: AssetManifest = {
    version: manifests.map((m) => `${m.pack}@${m.version}`).join("+"),
    pack: manifests.map((m) => m.pack).join("+"),
    atlases: [],
    sprites: {},
    animations: {},
    licenses: [],
  };
  const atlases = new Map<string, AtlasRef>();
  for (const m of manifests) {
    // Later packs win here too; the first occurrence keeps its load order.
    for (const a of m.atlases) atlases.set(a.id, a);
    Object.assign(out.sprites, m.sprites);
    Object.assign(out.animations, m.animations);
    out.licenses.push(...m.licenses);
  }
  out.atlases = [...atlases.values()];
  return out;
}

/**
 * Resolves an animation or sprite by logical id with fallback: tries `id`,
 * then drops trailing segments ("unit.hero.walk.ne" -> "unit.hero.walk" ->
 * "unit.hero"), then "missing". Lets placeholder packs cover partial sets.
 */
export function resolveId(table: Record<string, unknown>, id: string, missing = "missing"): string {
  let cur = id;
  while (cur) {
    if (cur in table) return cur;
    const dot = cur.lastIndexOf(".");
    if (dot < 0) break;
    cur = cur.slice(0, dot);
  }
  return missing;
}
