import { createSim, stableHash, type DispatchResult, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Prediction } from "../../src/client/instance/prediction.ts";
import { counterLoaded, counterLoadedV2, type Counter } from "./fixtures.ts";

const value = (snap: SimSnapshot | null) =>
  (snap!.world.resources["tcount.counter"] as Counter).value;

/** A "server": the same kernel sim, answering like the InstanceDO. */
function server(seed = 1) {
  const sim = createSim(counterLoaded, { seed });
  return {
    sim,
    result(seq: number, name: string, payload: unknown) {
      const res = sim.dispatch(name, payload, "me");
      return { seq, ok: res.ok, error: res.error, events: res.events, snapshot: sim.snapshot() };
    },
  };
}

function predictor() {
  const p = new Prediction(counterLoaded);
  p.actor = "me";
  const results = new Map<number, DispatchResult>();
  const enqueue = (name: string, payload: unknown) => {
    const e = p.enqueue(name, payload, (r) => results.set(e.seq, r));
    return e;
  };
  return { p, results, enqueue };
}

describe("Prediction", () => {
  it("predicts immediately and assigns increasing seqs", () => {
    const srv = server();
    const { p, enqueue } = predictor();
    const start = srv.sim.snapshot();
    p.onState(0, start);
    const a = enqueue("tcount.add", { by: 2 });
    const b = enqueue("tcount.add", { by: 3 });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(value(p.view)).toBe(value(start) + 5);
    expect(p.authoritative).toBe(start);
    expect(p.events).toEqual([{ type: "tcount.added", value: value(start) + 5, actor: "me" }]);
  });

  it("reconciles results without mismatch when the prediction was right", () => {
    const srv = server();
    const { p, results, enqueue } = predictor();
    p.onState(0, srv.sim.snapshot());
    enqueue("tcount.add", { by: 2 });
    enqueue("tcount.roll", null);
    const predicted = p.view;
    const r1 = p.onResult(srv.result(1, "tcount.add", { by: 2 }));
    expect(r1?.mismatch).toBeNull();
    expect(p.pending.map((x) => x.seq)).toEqual([2]);
    expect(p.view).toEqual(predicted);
    const r2 = p.onResult(srv.result(2, "tcount.roll", null));
    expect(r2?.mismatch).toBeNull();
    expect(p.view).toEqual(srv.sim.snapshot());
    expect(results.get(1)?.ok).toBe(true);
    expect(results.get(2)).toMatchObject({ ok: true, tick: 2 });
  });

  it("lets the server win and replays pending actions on top", () => {
    const srv = server();
    const { p, enqueue } = predictor();
    p.onState(0, srv.sim.snapshot());
    enqueue("tcount.add", { by: 1 });
    enqueue("tcount.add", { by: 1 });
    // Something else changed the server state first (e.g. another player).
    srv.sim.dispatch("tcount.add", { by: 10 }, "other");
    const res = p.onResult(srv.result(1, "tcount.add", { by: 1 }));
    expect(res?.mismatch).not.toBeNull();
    expect(res?.mismatch?.server).toBe(stableHash(srv.sim.snapshot()));
    // View = server after seq 1 + pending seq 2 replayed.
    expect(value(p.view)).toBe(value(srv.sim.snapshot()) + 1);
  });

  it("records server rejections and clears them on the next success", () => {
    const srv = server();
    const { p, results, enqueue } = predictor();
    p.onState(0, srv.sim.snapshot());
    enqueue("tcount.add", { by: 1000 });
    expect(p.error?.code).toBe("too_big");
    p.onResult(srv.result(1, "tcount.add", { by: 1000 }));
    expect(results.get(1)).toMatchObject({ ok: false, error: { code: "too_big" } });
    expect(p.error?.code).toBe("too_big");
    enqueue("tcount.add", { by: 1 });
    p.onResult(srv.result(2, "tcount.add", { by: 1 }));
    expect(p.error).toBeNull();
  });

  it("ignores results for unknown seqs", () => {
    const srv = server();
    const { p } = predictor();
    const start = srv.sim.snapshot();
    p.onState(0, start);
    expect(p.onResult(srv.result(9, "tcount.add", { by: 1 }))).toBeNull();
    expect(p.view).toBe(start);
  });

  it("on a join state, resolves applied actions and returns the rest to resend", () => {
    const srv = server();
    const { p, results, enqueue } = predictor();
    p.onState(0, srv.sim.snapshot());
    enqueue("tcount.add", { by: 1 });
    enqueue("tcount.add", { by: 2 });
    enqueue("tcount.add", { by: 3 });
    // Seq 1 reached the server, then the socket dropped.
    srv.result(1, "tcount.add", { by: 1 });
    const resend = p.onState(1, srv.sim.snapshot());
    expect(resend.map((x) => x.seq)).toEqual([2, 3]);
    expect(results.get(1)).toMatchObject({ ok: true, events: [] });
    expect(value(p.view)).toBe(value(srv.sim.snapshot()) + 5);
  });

  it("continues seqs after the server's lastSeq (page reload)", () => {
    const srv = server();
    const { p, enqueue } = predictor();
    p.onState(41, srv.sim.snapshot());
    expect(p.nextSeq).toBe(42);
    expect(enqueue("tcount.roll", null).seq).toBe(42);
  });

  it("queues without predicting before the first state", () => {
    const srv = server();
    const { p, enqueue } = predictor();
    const e = enqueue("tcount.add", { by: 2 });
    expect(e.predictedHash).toBeNull();
    expect(p.view).toBeNull();
    const start = srv.sim.snapshot();
    expect(p.onState(0, start).map((x) => x.seq)).toEqual([1]);
    expect(value(p.view)).toBe(value(start) + 2);
  });

  it("dropPending rejects every pending action and shows the server state", () => {
    const srv = server();
    const { p, results, enqueue } = predictor();
    const start = srv.sim.snapshot();
    p.onState(0, start);
    enqueue("tcount.add", { by: 2 });
    p.dropPending("restarted", "x");
    expect(results.get(1)?.error?.code).toBe("restarted");
    expect(p.view).toBe(start);
    expect(p.pending).toHaveLength(0);
  });

  it("turns prediction off when server snapshots don't match the local modules", () => {
    const other = createSim(counterLoadedV2, { seed: 1 }).snapshot();
    const p = new Prediction(counterLoaded);
    const warn = console.warn;
    console.warn = () => {};
    try {
      p.onState(0, other);
      p.enqueue("tcount.add", { by: 1 }, () => {});
    } finally {
      console.warn = warn;
    }
    expect(p.predictable).toBe(false);
    expect(p.view).toBe(other);
  });
});
