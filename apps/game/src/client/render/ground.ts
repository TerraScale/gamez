import { Container, Graphics, GraphicsContext, Sprite } from "pixi.js";
import { DEFAULT_ISO, depthOf, tileToScreen, type TileMap } from "@gamez/world";
import { CHUNK_TILES } from "./chunks.ts";
import { groundFallbackColour, wallColour } from "./palette.ts";
import { diamondPoints, tallBox, type Primitives } from "./primitives.ts";
import type { Visuals } from "./visuals.ts";

/** Ground of one chunk is one cached container; its objects are direct children of the world layer. */
export interface ChunkView {
  cx: number;
  cy: number;
  /** Null when the chunk has no ground tiles. */
  ground: Container | null;
  props: Container[];
}

export interface ChunkContext {
  map: TileMap;
  visuals: Visuals;
  prims: Primitives;
  /** Shared tall-box contexts, keyed by colour. Owned by the renderer. */
  walls: Map<number, GraphicsContext>;
}

/**
 * Builds the ground (cached as one texture) and the object sprites of a chunk.
 * Object sprites go into `world`, the depth-sorted layer, so units can walk
 * between them; they are tracked per chunk so the chunk can be torn down.
 */
export function buildChunk(
  ctx: ChunkContext,
  cx: number,
  cy: number,
  groundLayer: Container,
  world: Container,
): ChunkView {
  const { map, visuals } = ctx;
  const { width, height, ground, objects } = map;
  const x0 = cx * CHUNK_TILES;
  const y0 = cy * CHUNK_TILES;
  const x1 = Math.min(x0 + CHUNK_TILES, width);
  const y1 = Math.min(y0 + CHUNK_TILES, height);

  const groundBox = new Container();
  let fallback: Graphics | null = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const id = ground[y * width + x];
      if (!id) continue;
      const vis = id === "tile.void" ? null : visuals.sprite(id);
      if (vis) {
        const sp = new Sprite(vis.texture);
        sp.anchor.set(vis.anchor?.x ?? 0.5, vis.anchor?.y ?? 0);
        const s = tileToScreen(x, y);
        sp.position.set(s.sx, s.sy);
        sp.scale.set(DEFAULT_ISO.tileWidth / vis.texture.width);
        groundBox.addChild(sp);
      } else {
        if (!fallback) fallback = new Graphics();
        fallback.poly(diamondPoints(x, y)).fill(groundFallbackColour(id));
      }
    }
  }
  if (fallback) groundBox.addChild(fallback);

  let groundRef: Container | null = null;
  if (groundBox.children.length > 0) {
    groundBox.cacheAsTexture(true);
    groundLayer.addChild(groundBox);
    groundRef = groundBox;
  } else {
    groundBox.destroy();
  }

  const props: Container[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const id = objects[y * width + x];
      if (!id) continue;
      const node = makeProp(id, ctx);
      const s = tileToScreen(x + 0.5, y + 0.5);
      node.position.set(s.sx, s.sy);
      node.zIndex = depthOf(x, y);
      world.addChild(node);
      props.push(node);
    }
  }
  return { cx, cy, ground: groundRef, props };
}

function makeProp(id: string, ctx: ChunkContext): Container {
  const { visuals, prims, walls } = ctx;
  const vis = visuals.sprite(id);
  if (vis) {
    return new Sprite({
      texture: vis.texture,
      anchor: { x: vis.anchor?.x ?? 0.5, y: vis.anchor?.y ?? 1 },
    });
  }
  if (id.includes("tree")) return new Graphics(prims.tree);
  if (id.startsWith("wall")) {
    const colour = wallColour(id);
    let shape = walls.get(colour);
    if (!shape) {
      shape = tallBox(colour);
      walls.set(colour, shape);
    }
    return new Graphics(shape);
  }
  return new Graphics(prims.box);
}

/** Removes a chunk from the scene and frees its cached ground texture. */
export function destroyChunk(chunk: ChunkView): void {
  const g = chunk.ground;
  if (g) {
    g.cacheAsTexture(false);
    g.destroy({ children: true });
  }
  for (const p of chunk.props) p.destroy({ children: true });
  chunk.props.length = 0;
  chunk.ground = null;
}
