/**
 * Minimap (classic.hud.topRight): explored tiles from the bitset, dots by kind,
 * redrawn at 5 Hz from api.minimap(). Also exports MinimapCanvas for the automap.
 */
import { useEffect, useRef } from "react";
import { GOLD_COLOR, hex, type ClassicClientApi, type MinimapData } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useCompact, type SlotProps } from "../common.tsx";
import { dotColor, isBitSet } from "../format.ts";
import { labelStyle, panelStyle } from "../styles.ts";

export const MINIMAP_INTERVAL_MS = 200;

export const MM_COLOR = {
  fog: [10, 9, 8],
  floor: [74, 68, 56],
  wall: [30, 26, 21],
} as const;

/** RGBA pixels of the map (one per tile): fog for unexplored tiles, floor and wall otherwise. */
export function minimapPixels(data: MinimapData): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, walkable } = data.map;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const known = data.explored === null || isBitSet(data.explored, width, x, y);
      const rgb = !known ? MM_COLOR.fog : walkable[i] === 1 ? MM_COLOR.floor : MM_COLOR.wall;
      out[i * 4] = rgb[0];
      out[i * 4 + 1] = rgb[1];
      out[i * 4 + 2] = rgb[2];
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

let scratch: HTMLCanvasElement | null = null;

function scratchFor(w: number, h: number): HTMLCanvasElement {
  if (!scratch || scratch.width !== w || scratch.height !== h) {
    scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}

/** Draws one minimap frame: map pixels scaled to `size`, then the dots and the hero. */
export function drawMinimapFrame(
  canvas: HTMLCanvasElement,
  data: MinimapData | null,
  size: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);
  if (!data) return;
  const { width: w, height: h } = data.map;
  const tiles = scratchFor(w, h);
  const tctx = tiles.getContext("2d");
  if (!tctx) return;
  tctx.putImageData(new ImageData(minimapPixels(data), w, h), 0, 0);
  const scale = size / Math.max(w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiles, 0, 0, w * scale, h * scale);
  for (const d of data.dots) {
    const r = d.kind === "monster" ? 2 : 3;
    ctx.fillStyle = hex(dotColor(d.kind));
    ctx.fillRect(d.x * scale - r / 2, d.y * scale - r / 2, r, r);
  }
  ctx.fillStyle = hex(GOLD_COLOR);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1;
  ctx.fillRect(data.heroX * scale - 2, data.heroY * scale - 2, 4, 4);
  ctx.strokeRect(data.heroX * scale - 2, data.heroY * scale - 2, 4, 4);
}

export function MinimapCanvas({
  api,
  size,
  cssWidth,
  label = "Minimap",
}: {
  api: ClassicClientApi;
  size: number;
  cssWidth?: string | number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => drawMinimapFrame(canvas, api.minimap(), size);
    draw();
    const id = setInterval(draw, MINIMAP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [api, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      aria-label={label}
      style={{
        display: "block",
        width: cssWidth ?? size,
        height: "auto",
        aspectRatio: "1 / 1",
        borderRadius: 6,
        background: "#0a0908",
      }}
    />
  );
}

export function Minimap({ api }: SlotProps) {
  const show = useSelect(api.ui, (u) => u.settings.showMinimap);
  const compact = useCompact(api);
  if (!show) return null;
  return (
    <div
      aria-label="Minimap panel"
      style={{ ...panelStyle, padding: 4, borderRadius: 8, width: compact ? 104 : 168 }}
    >
      <MinimapCanvas api={api} size={compact ? 96 : 160} />
      {compact ? null : (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 4,
            gap: 4,
          }}
        >
          <span style={{ ...labelStyle, fontSize: 11 }}>M hides · Tab map</span>
          <div style={{ display: "flex", gap: 4 }}>
            <Btn
              height={44}
              minWidth={44}
              fontSize={11}
              label="Open automap"
              onClick={() => api.openPanel("map")}
            >
              Map
            </Btn>
            <Btn
              height={44}
              minWidth={44}
              fontSize={11}
              label="Hide minimap"
              onClick={() => api.updateSettings({ showMinimap: false })}
            >
              Hide
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
