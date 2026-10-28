import type { AssetManifest } from "@gamez/assets";
import type { TileMap } from "@gamez/world";

/**
 * Rendering contract for the isometric world view. The net/game layer owns
 * all state and calls into the renderer every frame; the renderer owns Pixi.
 */
export interface WorldRenderer {
  /** Creates the Pixi app inside `host` and loads the atlases in `manifest`. */
  init(host: HTMLElement, manifest: AssetManifest, baseUrl: string): Promise<void>;
  /** (Re)draws the static map layers. */
  setMap(map: TileMap): void;
  /**
   * Adds or updates an avatar at a fractional tile position. `facing` is one
   * of the 8 iso directions; `moving` picks the walk vs idle animation.
   */
  upsertEntity(e: RenderEntity): void;
  removeEntity(id: string): void;
  /** Keeps the camera centred on a fractional tile position (smoothed). */
  follow(x: number, y: number): void;
  /** Called with the integer tile under a click/tap (only for in-bounds tiles). */
  onTileTap(cb: (x: number, y: number) => void): void;
  /** Marks the tap target briefly (feedback for tap-to-move). */
  showTapMarker(x: number, y: number): void;
  /** Registers a per-frame callback (dt in ms) driven by the Pixi ticker. */
  onFrame(cb: (dtMs: number) => void): void;
  destroy(): void;
}

export type Facing = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface RenderEntity {
  id: string;
  name: string;
  /** Logical appearance id, e.g. "unit.hero"; resolved as `${appearance}.${walk|idle}.${facing}` with fallback. */
  appearance: string;
  x: number;
  y: number;
  facing: Facing;
  moving: boolean;
  isSelf: boolean;
}
