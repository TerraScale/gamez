/**
 * The steps log shows each action's events once: a predicted action confirmed by the
 * server adds no second copy of its lines. Drives the real Prediction (apps/game) with a
 * fake connection in front of a server sim.
 */
import { createSim, type GameEvent } from "@gamez/kernel";
import { findPath } from "@gamez/world";
import type { InstanceConnection, InstanceView, WorldRenderer } from "@gamez/ui-host";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Prediction } from "../../../apps/game/src/client/instance/prediction.ts";
import { chebyshev } from "../src/components.ts";
import { createStepsController } from "../src/client/controller.ts";
import { describeEvent } from "../src/client/scene.ts";
import { floorOfSim, heroPos, isOver, loaded, monsters } from "./fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The next action of a scripted player: strike an adjacent monster, else walk the path to the stairs. */
function nextAction(sim: ReturnType<typeof createSim>): { name: string; payload: unknown } | null {
  if (isOver(sim)) return null;
  const floor = floorOfSim(sim);
  const hero = heroPos(sim);
  if (hero.x === floor.stairs.x && hero.y === floor.stairs.y) {
    return { name: "steps.descend", payload: {} };
  }
  const foe = monsters(sim).find((m) => chebyshev(m.pos, hero) === 1);
  const next = foe?.pos ?? findPath(floor, hero, floor.stairs)?.[0];
  if (!next) return { name: "steps.wait", payload: {} };
  return { name: "steps.move", payload: { dx: next.x - hero.x, dy: next.y - hero.y } };
}

function describable(events: readonly GameEvent[]): string[] {
  return events
    .map((ev) => describeEvent(ev, loaded.registry))
    .filter((t): t is string => t !== null);
}

function setup() {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const srv = createSim(loaded, { seed: 1 });
  const predictor = new Prediction(loaded);
  predictor.actor = "me";
  predictor.onState(0, srv.snapshot());

  const subs = new Set<(v: InstanceView) => void>();
  const view = (): InstanceView => ({
    status: "online",
    snapshot: predictor.view,
    world: null,
    events: predictor.events,
    error: predictor.error,
    pingMs: null,
  });
  const emit = () => {
    for (const cb of subs) cb(view());
  };
  const conn = {
    loaded,
    getView: view,
    subscribe(cb: (v: InstanceView) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    act(name: string, payload: unknown) {
      return new Promise((resolve) => {
        predictor.enqueue(name, payload, resolve);
        emit();
      });
    },
    restart() {},
  } as unknown as InstanceConnection;

  const renderer = {
    onTileTap() {},
    onFrame() {},
    setMap() {},
    upsertEntity() {},
    removeEntity() {},
    follow() {},
    showTapMarker() {},
  } as unknown as WorldRenderer;

  const ctrl = createStepsController(renderer, conn);
  /** The server answers the action with `seq` like the InstanceDO does. */
  const answer = (seq: number, name: string, payload: unknown) => {
    const res = srv.dispatch(name, payload, "me");
    predictor.onResult({
      seq,
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      events: res.events,
      snapshot: srv.snapshot(),
    });
    emit();
    return res;
  };
  return { srv, ctrl, conn, answer, predictor };
}

describe("steps client log", () => {
  it("one action yields one log line through predict + confirm", () => {
    const { srv, ctrl, conn, answer, predictor } = setup();
    const lines = () => ctrl.store.getSnapshot().log.map((l) => l.text);

    // Play until the first strike: its line must appear exactly once.
    let attackLine: string | null = null;
    for (let i = 0; i < 200 && attackLine === null; i++) {
      const next = nextAction(srv);
      if (!next) break;
      const before = lines().length;
      void conn.act(next.name, next.payload);
      const seq = predictor.nextSeq - 1;
      const predictedLines = describable(predictor.events);
      expect(lines()).toHaveLength(before + predictedLines.length);

      const res = answer(seq, next.name, next.payload);
      // Confirmation adds nothing: the same lines, once.
      expect(lines()).toHaveLength(before + predictedLines.length);
      expect(describable(res.events)).toEqual(predictedLines);
      const hit = predictedLines.find((t) => t.includes("hits"));
      if (hit !== undefined) attackLine = hit;
    }

    expect(attackLine).not.toBeNull();
    expect(lines().filter((t) => t === attackLine).length).toBeGreaterThanOrEqual(1);
    ctrl.destroy();
  });

  it("a whole scripted run logs each server event line once", () => {
    const { srv, ctrl, conn, answer, predictor } = setup();
    let expected = 0;
    for (let i = 0; i < 30; i++) {
      const next = nextAction(srv);
      if (!next) break;
      void conn.act(next.name, next.payload);
      const seq = predictor.nextSeq - 1;
      const res = answer(seq, next.name, next.payload);
      expected += describable(res.events).length;
      if (expected >= 30) break;
    }
    expect(ctrl.store.getSnapshot().log).toHaveLength(expected);
    ctrl.destroy();
  });
});
