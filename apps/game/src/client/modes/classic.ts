/**
 * Classic mode: the phase-0 town with tap-to-move, presence and the Pixi
 * renderer. The app shell mounts it into a full-screen host; cleanup closes
 * the socket and destroys the renderer.
 */
import { townMap } from "@gamez/classic.town";
import type { EntityId, ModeInfo, ServerMessage } from "@gamez/protocol";
import type { ClientModeView } from "@gamez/ui-host";
import { planWalk, walkAt } from "../../shared/walk.ts";
import { ClockSync } from "../clock.ts";
import { Connection, type NetStatus } from "../net.ts";
import { createOverlay } from "../overlay.ts";
import { facingFromDelta } from "../render/facing.ts";
import type { Facing } from "../render/types.ts";
import { clearSession, getSession, type GuestSession } from "../session.ts";
import { WorldState } from "../state.ts";

const CLASSIC_WORLD = "classic-world";

/** Catalog entry for the classic mode; the picker always lists it. */
export const classicInfo: ModeInfo = {
  id: "plaza",
  name: "Town Plaza",
  description:
    "Multiplayer presence demo: a shared isometric town. Tap to walk, meet other players.",
  world: CLASSIC_WORLD,
};

function wsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export const classicMode: ClientModeView = {
  modeId: "plaza",
  async mount(host, services) {
    // Own layer inside the host, so cleanup can remove everything this mode added.
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0";
    host.appendChild(layer);

    const overlay = createOverlay(layer);
    overlay.message("loading…");

    const renderer = services.createWorldRenderer();
    try {
      await renderer.init(layer, services.manifest, services.assetBaseUrl);
    } catch (err) {
      renderer.destroy();
      layer.remove();
      throw err;
    }
    renderer.setMap(townMap);

    const world = new WorldState();
    const clock = new ClockSync();
    const facings = new Map<EntityId, Facing>();
    let session: GuestSession | null = services.session;
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

    return () => {
      conn.stop();
      renderer.destroy();
      layer.remove();
    };
  },
};
