import type { AssetManifest } from "@gamez/assets";
import { townMap } from "@gamez/classic.town";
import type { EntityId, ServerMessage } from "@gamez/protocol";
import { planWalk, walkAt } from "../shared/walk.ts";
import { ClockSync } from "./clock.ts";
import { Connection, type NetStatus } from "./net.ts";
import { createOverlay } from "./overlay.ts";
import { facingFromDelta } from "./render/facing.ts";
import { createWorldRenderer } from "./render/pixi-renderer.ts";
import type { Facing } from "./render/types.ts";
import { clearSession, getSession, type GuestSession } from "./session.ts";
import { WorldState } from "./state.ts";

const ART_BASE = "/art/kenney/";
const EMPTY_MANIFEST: AssetManifest = {
  version: "0",
  pack: "none",
  atlases: [],
  sprites: {},
  animations: {},
  licenses: [],
};

async function loadManifest(): Promise<AssetManifest> {
  try {
    const res = await fetch(`${ART_BASE}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Missing files fall through to the SPA's index.html, so a parse error means "no manifest".
    return (await res.json()) as AssetManifest;
  } catch (err) {
    console.warn("asset manifest unavailable, using placeholders", err);
    return EMPTY_MANIFEST;
  }
}

function wsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

async function main(): Promise<void> {
  const host = document.getElementById("game")!;
  const overlay = createOverlay(document.body);
  overlay.message("loading…");

  const renderer = createWorldRenderer();
  await renderer.init(host, await loadManifest(), ART_BASE);
  renderer.setMap(townMap);

  const world = new WorldState();
  const clock = new ClockSync();
  const facings = new Map<EntityId, Facing>();
  let session: GuestSession | null = null;
  let status: NetStatus = "connecting";

  const conn = new Connection({
    clock,
    async url() {
      session ??= await getSession();
      return wsUrl(session.token);
    },
    onStatus(s) {
      status = s;
    },
    onUnauthorized() {
      clearSession();
      session = null;
    },
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case "welcome":
          if (clock.rtt === null) clock.seed(msg.serverTime);
          world.reset(msg);
          return;
        case "delta":
          if (world.applyDelta(msg) === "gap") conn.resync();
          return;
        case "error":
          // A rejected move: fall back to the server's path.
          world.clearPrediction();
          console.warn("server error", msg.code, msg.message);
          return;
        case "pong":
          return;
      }
    },
  });

  renderer.onTileTap((x, y) => {
    renderer.showTapMarker(x, y);
    conn.send({ t: "moveTo", target: { x, y } });
    const self = world.self();
    if (!self) return;
    const plan = planWalk(townMap, self, { x, y }, clock.serverNow());
    if (plan.ok) world.predictSelf(plan.walk);
  });

  let overlayAt = 0;
  renderer.onFrame(() => {
    for (const id of world.drainRemoved()) {
      renderer.removeEntity(id);
      facings.delete(id);
    }
    const now = clock.serverNow();
    for (const e of world.visible()) {
      const at = walkAt(e, now);
      let facing = facings.get(e.id) ?? "s";
      if (at.next) {
        facing = facingFromDelta(at.next.x - at.from.x, at.next.y - at.from.y);
        facings.set(e.id, facing);
      }
      const isSelf = e.id === world.selfId;
      renderer.upsertEntity({
        id: e.id,
        name: e.name,
        appearance: e.appearance,
        x: at.x,
        y: at.y,
        facing,
        moving: !at.done,
        isSelf,
      });
      if (isSelf) renderer.follow(at.x, at.y);
    }
    if (performance.now() - overlayAt > 250) {
      overlayAt = performance.now();
      overlay.update({
        status,
        name: session?.name ?? null,
        players: world.entities.size,
        pingMs: clock.rtt,
      });
    }
  });

  conn.start();
}

main().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById("game");
  if (el) el.textContent = `failed to start: ${String(err)}`;
});
