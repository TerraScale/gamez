import type { NetStatus } from "./net.ts";

export interface OverlayInfo {
  status: NetStatus | "error";
  name: string | null;
  players: number;
  pingMs: number | null;
}

/** Tiny status line in the top-left corner (plain DOM, outside Pixi). */
export function createOverlay(host: HTMLElement) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:10;padding:4px 8px;border-radius:4px;" +
    "font:12px/1.4 ui-monospace,monospace;color:#e6e9ef;background:rgba(0,0,0,.55);" +
    "pointer-events:none;white-space:pre";
  host.appendChild(el);
  let last = "";
  return {
    update(info: OverlayInfo): void {
      const ping = info.pingMs === null ? "–" : `${Math.round(info.pingMs)} ms`;
      const who = info.name ? `${info.name} · ` : "";
      const text = `${who}${info.status} · ${info.players} online · ping ${ping}`;
      if (text !== last) el.textContent = last = text;
    },
    message(text: string): void {
      el.textContent = last = text;
    },
  };
}
