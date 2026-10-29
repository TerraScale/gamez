/**
 * Minimap (classic.hud.topRight): explored tiles from the bitset, dots by kind,
 * redrawn at 5 Hz from api.minimap(). Also exports MinimapCanvas for the automap.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { hex, type ClassicClientApi, type MinimapData } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudLayout, type SlotProps } from "../common.tsx";
import { DOT_COLOR, isBitSet, type MinimapDotKind } from "../format.ts";
import { MINIMAP_CHIP, MINIMAP_SIZE } from "../layout.ts";
import { panelStyle } from "../styles.ts";

export const MINIMAP_INTERVAL_MS = 200;

/** The hero's own colour: cyan, so it never reads as a monster, portal, waypoint or stairs. */
export const HERO_COLOR = 0x35e0ff;
/** Smallest hero dot (CSS px) on the compact minimap; grows with the canvas. */
export const HERO_MIN_DIAMETER = 10;

/** Other party members on the minimap: a lighter cyan than the hero's dot. */
export const PARTY_DOT_COLOR = 0x9ff0ff;

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

export type MarkerShape = "square" | "circle" | "diamond" | "triangle" | "ring";

/** Shape and size of each marker kind. Stairs, waypoints and portals are big and distinct, so they read at a glance. */
export const MARKER: Record<MinimapDotKind, { shape: MarkerShape; size: number }> = {
  monster: { shape: "square", size: 3 },
  champion: { shape: "square", size: 4 },
  boss: { shape: "square", size: 6 },
  npc: { shape: "circle", size: 8 },
  loot: { shape: "square", size: 4 },
  stairs: { shape: "triangle", size: 9 },
  waypoint: { shape: "diamond", size: 9 },
  portal: { shape: "ring", size: 8 },
};

/** Draws one marker centred on (x, y) in canvas pixels, with a black keyline so it stands out on fog. */
export function drawMarker(
  ctx: CanvasRenderingContext2D,
  kind: MinimapDotKind,
  x: number,
  y: number,
): void {
  const { shape, size } = MARKER[kind];
  const h = size / 2;
  const color = hex(DOT_COLOR[kind]);
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(x - h, y - h, size, size);
  } else if (shape === "circle") {
    ctx.arc(x, y, h, 0, Math.PI * 2);
  } else if (shape === "diamond") {
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h, y);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x - h, y);
    ctx.closePath();
  } else if (shape === "triangle") {
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h, y + h);
    ctx.lineTo(x - h, y + h);
    ctx.closePath();
  } else {
    ctx.arc(x, y, h - 1, 0, Math.PI * 2);
  }
  if (shape === "ring") {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#000000";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    return;
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#000000";
  ctx.stroke();
}

/** Legend swatch of the hero: the same cyan dot and white ring the minimap draws. */
export function HeroSwatch() {
  const box = 12;
  return (
    <svg
      aria-hidden="true"
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      style={{ flex: "none" }}
    >
      <circle cx={6} cy={6} r={4.5} fill={hex(HERO_COLOR)} stroke="#ffffff" strokeWidth={1.5} />
      <circle cx={6} cy={6} r={5.8} fill="none" stroke="#000" strokeWidth={0.8} />
    </svg>
  );
}

/** A legend swatch with the same shape and colour as the marker on the map. */
export function MarkerSwatch({ kind }: { kind: MinimapDotKind }) {
  const { shape, size } = MARKER[kind];
  const box = 12;
  const c = box / 2;
  const h = Math.min(size, box - 2) / 2;
  const color = hex(DOT_COLOR[kind]);
  let glyph: ReactNode;
  if (shape === "square") glyph = <rect x={c - h} y={c - h} width={h * 2} height={h * 2} />;
  else if (shape === "circle") glyph = <circle cx={c} cy={c} r={h} />;
  else if (shape === "diamond")
    glyph = <polygon points={`${c},${c - h} ${c + h},${c} ${c},${c + h} ${c - h},${c}`} />;
  else if (shape === "triangle")
    glyph = <polygon points={`${c},${c - h} ${c + h},${c + h} ${c - h},${c + h}`} />;
  else glyph = <circle cx={c} cy={c} r={h - 1} fill="none" stroke={color} strokeWidth={2} />;
  return (
    <svg
      aria-hidden="true"
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      style={{ flex: "none" }}
    >
      <g fill={shape === "ring" ? "none" : color} stroke="#000" strokeWidth={1}>
        {glyph}
      </g>
    </svg>
  );
}

/** Draws one minimap frame: map pixels scaled to `size`, then the markers and the hero. */
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
  // Stairs and waypoints first, so monsters drawn after them never hide a way out.
  const order: MinimapDotKind[] = [
    "loot",
    "monster",
    "champion",
    "npc",
    "boss",
    "portal",
    "waypoint",
    "stairs",
  ];
  for (const kind of order) {
    for (const d of data.dots) {
      if (d.kind === kind) drawMarker(ctx, kind, (d.x + 0.5) * scale, (d.y + 0.5) * scale);
    }
  }
  // Party members (docs/design/party.md §10.5): small cyan dots, hollow when downed.
  for (const m of data.party ?? []) {
    const px = (m.x + 0.5) * scale;
    const py = (m.y + 0.5) * scale;
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    if (m.dead) {
      // Hollow: black keyline, then the cyan ring on top.
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#000000";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hex(PARTY_DOT_COLOR);
      ctx.stroke();
    } else {
      ctx.fillStyle = hex(PARTY_DOT_COLOR);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#000000";
      ctx.stroke();
    }
  }
  // The hero: a cyan dot with a white ring and a black keyline, at least HERO_MIN_DIAMETER px across.
  const hx = (data.heroX + 0.5) * scale;
  const hy = (data.heroY + 0.5) * scale;
  const r = Math.max(HERO_MIN_DIAMETER / 2, Math.round(size / 40));
  ctx.beginPath();
  ctx.arc(hx, hy, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#000000";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, Math.PI * 2);
  ctx.fillStyle = hex(HERO_COLOR);
  ctx.fill();
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
  const layout = useHudLayout(api);
  if (!show) {
    // Hidden: a Map chip in the same corner brings it back (the M key and Settings > Minimap do the same).
    return (
      <Btn
        label="Show minimap"
        title="Show minimap (M)"
        height={MINIMAP_CHIP}
        minWidth={MINIMAP_CHIP}
        fontSize={12}
        onClick={() => api.updateSettings({ showMinimap: true })}
      >
        Map
      </Btn>
    );
  }
  const size = MINIMAP_SIZE[layout];
  return (
    <div
      aria-label="Minimap panel"
      style={{ ...panelStyle, padding: 4, borderRadius: 8, width: size.width }}
    >
      <MinimapCanvas api={api} size={size.canvas} />
      {size.buttons ? (
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <Btn
            height={44}
            minWidth={44}
            fontSize={12}
            label="Open automap"
            title="Automap (Tab)"
            style={{ flex: 1, padding: "0 4px" }}
            onClick={() => api.openPanel("map")}
          >
            Map
          </Btn>
          <Btn
            height={44}
            minWidth={44}
            fontSize={12}
            label="Hide minimap"
            title="Hide minimap (M)"
            style={{ flex: 1, padding: "0 4px" }}
            onClick={() => api.updateSettings({ showMinimap: false })}
          >
            Hide
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
