/**
 * Framework-free controller for the steps client: follows the instance
 * connection, keeps the renderer in step with the board, turns keys and taps
 * into actions and keeps the HUD store and event log.
 */
import type { Facing, InstanceConnection, InstanceView, WorldRenderer } from "@gamez/ui-host";
import type { Pos } from "../components.ts";
import {
  type Board,
  describeEvent,
  facingFor,
  type Intent,
  intentForKey,
  onStairs,
  readBoard,
  renderEntities,
} from "./scene.ts";

export interface LogLine {
  id: number;
  text: string;
}

export interface HudState {
  status: InstanceView["status"];
  board: Board | null;
  turn: number;
  log: LogLine[];
  error: InstanceView["error"];
  pingMs: number | null;
  onStairs: boolean;
}

export interface HudStore {
  getSnapshot: () => HudState;
  subscribe: (cb: () => void) => () => void;
}

export interface StepsController {
  store: HudStore;
  act(intent: Intent): void;
  restart(): void;
  destroy(): void;
}

const LOG_LIMIT = 40;

/** Stable key for a floor's static layers: the renderer only re-draws the map when it changes. */
function mapKey(board: Board): string {
  const { floor } = board;
  return [
    floor.id,
    floor.ground.join(","),
    floor.objects.map((o) => o ?? "").join(","),
    floor.walkable.join(""),
  ].join("|");
}

export function createStepsController(
  renderer: WorldRenderer,
  conn: InstanceConnection,
): StepsController {
  const registry = conn.loaded.registry;
  const listeners = new Set<() => void>();
  let view: InstanceView = conn.getView();
  let board: Board | null = null;
  let log: LogLine[] = [];
  let nextLogId = 1;
  let lastEvents: InstanceView["events"] | null = null;
  let state: HudState = {
    status: view.status,
    board: null,
    turn: 0,
    log,
    error: null,
    pingMs: null,
    onStairs: false,
  };

  // Renderer bookkeeping.
  let drawnMap: string | null = null;
  let drawnIds = new Set<string>();
  let heroPos: Pos | null = null;
  let heroFacing: Facing = "s";
  let follow: Pos | null = null;

  function pushLog(text: string): void {
    log = [...log, { id: nextLogId++, text }].slice(-LOG_LIMIT);
  }

  function draw(b: Board): void {
    const key = mapKey(b);
    if (key !== drawnMap) {
      renderer.setMap(b.floor);
      drawnMap = key;
      heroPos = null;
    }
    if (b.hero) {
      if (heroPos !== null) {
        const f = facingFor(b.hero.pos.x - heroPos.x, b.hero.pos.y - heroPos.y);
        if (f !== null) heroFacing = f;
      }
      heroPos = { ...b.hero.pos };
      follow = heroPos;
    } else {
      follow = null;
    }
    const entities = renderEntities(b, heroFacing);
    const ids = new Set<string>();
    for (const e of entities) {
      renderer.upsertEntity(e);
      ids.add(e.id);
    }
    for (const id of drawnIds) if (!ids.has(id)) renderer.removeEntity(id);
    drawnIds = ids;
  }

  function publish(): void {
    state = {
      status: view.status,
      board,
      turn: view.snapshot?.tick ?? 0,
      log,
      error: view.error,
      pingMs: view.pingMs,
      onStairs: board !== null && onStairs(board),
    };
    for (const cb of listeners) cb();
  }

  function ingest(next: InstanceView): void {
    view = next;
    board = view.world ? readBoard(view.world, registry) : null;
    // Log each batch of events once: the connection hands over a new array per resolved action.
    if (view.events !== lastEvents) {
      lastEvents = view.events;
      for (const ev of view.events) {
        const text = describeEvent(ev, registry);
        if (text !== null) pushLog(text);
      }
    }
    if (board !== null) draw(board);
    else follow = null;
    publish();
  }

  function act(intent: Intent): void {
    if (board?.run.over) return;
    const call =
      intent.kind === "move"
        ? conn.act("steps.move", { dx: intent.dx, dy: intent.dy })
        : intent.kind === "wait"
          ? conn.act("steps.wait", {})
          : conn.act("steps.descend", {});
    void call.catch((err: unknown) => console.warn("steps: action failed", err));
  }

  renderer.onTileTap((x, y) => {
    renderer.showTapMarker(x, y);
    const hero = board?.hero;
    if (!hero) return;
    const dx = x - hero.pos.x;
    const dy = y - hero.pos.y;
    if (dx === 0 && dy === 0) act({ kind: "wait" });
    else if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) act({ kind: "move", dx, dy });
  });

  renderer.onFrame(() => {
    if (follow !== null) renderer.follow(follow.x, follow.y);
  });

  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const intent = intentForKey(e.key);
    if (intent === null) return;
    e.preventDefault();
    act(intent);
  }
  window.addEventListener("keydown", onKey);

  const unsubscribe = conn.subscribe(ingest);
  ingest(view);

  return {
    store: {
      getSnapshot: () => state,
      subscribe: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    act,
    restart() {
      pushLog("A new run begins.");
      conn.restart();
      publish();
    },
    destroy() {
      unsubscribe();
      window.removeEventListener("keydown", onKey);
      listeners.clear();
    },
  };
}
