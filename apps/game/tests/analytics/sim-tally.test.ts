/**
 * SimTally (docs/design/admin-dashboard.md §5): verified events fold into
 * sim.tally counters, play/sim time comes from dims, abort/resync/offline
 * behave as specified, flush caps the points (excess into "other"), due()
 * follows age and key count, and hook failures never escape.
 *
 * Uses a fake ModeAnalytics and a recording fake Analytics, so no world is
 * needed: the world is only passed through to the hooks.
 */
import type { GameEvent, ModeAnalytics, World } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  MS_PER_TICK,
  SimTally,
  TALLY_FLUSH_MS,
  TALLY_MAX_KEYS,
  TALLY_MAX_POINTS,
} from "../../src/server/analytics/sim-tally.ts";
import type { Analytics } from "../../src/server/analytics/types.ts";

interface Written {
  metric: string;
  blobs: Record<string, string | undefined>;
  doubles: Record<string, number | undefined>;
  index: string;
}

/** Records every write; flush is a no-op. */
class FakeAnalytics {
  readonly points: Written[] = [];
  write(
    metric: string,
    blobs: Record<string, string | undefined>,
    doubles?: Record<string, number | undefined>,
    index?: string,
  ): void {
    this.points.push({ metric, blobs, doubles: doubles ?? {}, index: index ?? "" });
  }
  async flush(): Promise<void> {}

  of(metric: string): Written[] {
    return this.points.filter((p) => p.metric === metric);
  }
  tally(metric: string, k1: string, k2 = ""): number {
    return this.of("sim.tally")
      .filter((p) => p.blobs.metric === metric && p.blobs.k1 === k1 && p.blobs.k2 === k2)
      .reduce((s, p) => s + (p.doubles.amount ?? 0), 0);
  }
}

const WORLD = {} as unknown as World;

const ev = (type: string, extra: Record<string, unknown> = {}): GameEvent => ({ type, ...extra });

/** Hooks that fold each event type into one counter, with fixed dims. */
function fakeHooks(over: Partial<ModeAnalytics> = {}): ModeAnalytics {
  return {
    dims: () => ({ control: "auto", levelBand: "10-19" }),
    fold(events, _world, tally) {
      for (const e of events) {
        if (e.type === "kill") tally("kill", String(e.monster), String(e.rarity), 1);
        if (e.type === "gold") tally("gold", "10-19", "pickup", Number(e.amount));
      }
    },
    offline: () => ({ kills: 3, xp: 40, gold: 9, items: 1, levels: 0 }),
    ...over,
  };
}

function flushed(tally: SimTally): FakeAnalytics {
  const a = new FakeAnalytics();
  tally.flush(a as unknown as Analytics, "acct_1", 0);
  return a;
}

describe("commit", () => {
  it("folds buffered events, adds play and sim time by dims, and counts the segment", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.onEvents([ev("kill", { monster: "classic.mob", rarity: "normal" }), ev("noise")]);
    tally.onEvents([ev("gold", { amount: 5 })]);
    tally.commit(WORLD, 40, 120);

    const a = flushed(tally);
    expect(a.tally("kill", "classic.mob", "normal")).toBe(1);
    expect(a.tally("gold", "10-19", "pickup")).toBe(5);
    expect(a.tally("play.ms", "auto", "10-19")).toBe(120);
    expect(a.tally("sim.ms", "auto", "10-19")).toBe(40 * MS_PER_TICK);
    expect(a.tally("verify.segments", "ok")).toBe(1);

    const seg = a.of("verify.segment");
    expect(seg).toHaveLength(1);
    expect(seg[0]!.blobs).toEqual({ mode: "classic", outcome: "ok" });
    expect(seg[0]!.doubles).toEqual({ ticks: 40, costMs: 120 });
    expect(seg[0]!.index).toBe("acct_1");
  });

  it("writes sim.tally points with mode, metric, k1, k2 blobs and the account as index", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.onEvents([ev("kill", { monster: "classic.mob", rarity: "elite" })]);
    tally.commit(WORLD, 1, 1);
    const kill = flushed(tally)
      .of("sim.tally")
      .find((p) => p.blobs.metric === "kill");
    expect(kill).toBeDefined();
    expect(kill!.blobs).toEqual({
      mode: "classic",
      metric: "kill",
      k1: "classic.mob",
      k2: "elite",
    });
    expect(kill!.doubles.amount).toBe(1);
    expect(kill!.index).toBe("acct_1");
  });

  it("without hooks, skips play time and fold but still counts the segment", () => {
    const tally = new SimTally("classic", undefined);
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    tally.commit(WORLD, 20, 99);
    const a = flushed(tally);
    expect(a.of("sim.tally").map((p) => p.blobs.metric)).toEqual(["verify.segments"]);
    expect(a.tally("verify.segments", "ok")).toBe(1);
    expect(a.of("verify.segment")[0]!.doubles).toEqual({ ticks: 20, costMs: 99 });
  });

  it("a throwing dims skips play time, but fold and verify still count", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        dims: () => {
          throw new Error("boom");
        },
      }),
    );
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    expect(() => tally.commit(WORLD, 20, 99)).not.toThrow();
    const a = flushed(tally);
    expect(a.of("sim.tally").some((p) => p.blobs.metric === "play.ms")).toBe(false);
    expect(a.tally("kill", "x", "normal")).toBe(1);
    expect(a.tally("verify.segments", "ok")).toBe(1);
  });

  it("a throwing fold never escapes and keeps the segment counted", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        fold() {
          throw new Error("fold failed");
        },
      }),
    );
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    expect(() => tally.commit(WORLD, 20, 99)).not.toThrow();
    const a = flushed(tally);
    expect(a.tally("verify.segments", "ok")).toBe(1);
    expect(a.tally("play.ms", "auto", "10-19")).toBe(99);
    expect(a.tally("kill", "x", "normal")).toBe(0);
  });

  it("a commit clears the buffer, so the next commit does not fold old events again", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    tally.commit(WORLD, 1, 1);
    tally.commit(WORLD, 1, 1);
    expect(flushed(tally).tally("kill", "x", "normal")).toBe(1);
  });
});

describe("abort", () => {
  it("drops the buffered events and counts the failed segment with its code", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    tally.abort("bad_hash");
    tally.commit(WORLD, 5, 5);
    const a = flushed(tally);
    expect(a.tally("kill", "x", "normal")).toBe(0);
    expect(a.tally("verify.segments", "bad_hash")).toBe(1);
    expect(a.tally("verify.segments", "ok")).toBe(1);
    const failed = a.of("verify.segment").find((p) => p.blobs.outcome === "bad_hash");
    expect(failed).toBeDefined();
    expect(failed!.doubles).toEqual({ ticks: 0, costMs: 0 });
  });
});

describe("resync", () => {
  it("counts verify.resyncs per code and writes one verify.resync point per code", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.resync("desync");
    tally.resync("desync");
    tally.resync("too_fast");
    const a = flushed(tally);
    expect(a.tally("verify.resyncs", "desync")).toBe(2);
    expect(a.tally("verify.resyncs", "too_fast")).toBe(1);
    const points = a.of("verify.resync").map((p) => p.blobs.code ?? "");
    expect(points.sort((x, y) => x.localeCompare(y))).toEqual(["desync", "too_fast"]);
    expect(a.of("verify.resync")[0]!.blobs.mode).toBe("classic");
  });
});

describe("offline", () => {
  it("records one sim.offline point per grant and does not fold its events", () => {
    const tally = new SimTally("classic", fakeHooks());
    const grantEvents = [ev("kill", { monster: "offline.mob", rarity: "normal" })];
    tally.offline(WORLD, 3_600_000, grantEvents);
    tally.offline(WORLD, 60_000, grantEvents);
    const a = flushed(tally);
    const off = a.of("sim.offline");
    expect(off).toHaveLength(2);
    expect(off[0]!.blobs).toEqual({ mode: "classic", levelBand: "10-19" });
    expect(off[0]!.doubles).toEqual({
      ms: 3_600_000,
      kills: 3,
      xp: 40,
      gold: 9,
      items: 1,
      levels: 0,
    });
    expect(off[0]!.index).toBe("acct_1");
    expect(a.tally("kill", "offline.mob", "normal")).toBe(0);
  });

  it("writes nothing when the mode has no offline hook or the hook grants nothing", () => {
    const none = new SimTally("classic", fakeHooks({ offline: undefined }));
    none.offline(WORLD, 1000, []);
    expect(flushed(none).of("sim.offline")).toHaveLength(0);

    const empty = new SimTally("classic", fakeHooks({ offline: () => null }));
    empty.offline(WORLD, 1000, []);
    expect(flushed(empty).of("sim.offline")).toHaveLength(0);
  });

  it("a throwing offline hook is swallowed", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        offline() {
          throw new Error("nope");
        },
      }),
    );
    expect(() => tally.offline(WORLD, 1000, [])).not.toThrow();
    expect(flushed(tally).of("sim.offline")).toHaveLength(0);
  });
});

describe("flush", () => {
  it("returns the points written, clears the state, and a second flush writes nothing", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    tally.commit(WORLD, 1, 1);
    const a = new FakeAnalytics();
    const n = tally.flush(a as unknown as Analytics, "acct_1", 0);
    expect(n).toBe(a.points.length);
    expect(n).toBeGreaterThan(0);
    const again = new FakeAnalytics();
    expect(tally.flush(again as unknown as Analytics, "acct_1", 0)).toBe(0);
    expect(again.points).toHaveLength(0);
  });

  it("caps the points at TALLY_MAX_POINTS and folds excess counters into k1 = other per metric", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        fold(events, _world, add) {
          for (const e of events) {
            if (e.type === "kill") add("kill", String(e.monster), "normal", Number(e.amount));
            if (e.type === "drop") add("drop", String(e.monster), "item", Number(e.amount));
          }
        },
      }),
    );
    // 300 distinct kill monsters plus 100 distinct drops; amounts 1..N.
    const events: GameEvent[] = [];
    for (let i = 0; i < 300; i++) events.push(ev("kill", { monster: `m${i}`, amount: i + 1 }));
    for (let i = 0; i < 100; i++) events.push(ev("drop", { monster: `d${i}`, amount: 1 }));
    tally.onEvents(events);
    tally.commit(WORLD, 10, 10);

    const a = new FakeAnalytics();
    const n = tally.flush(a as unknown as Analytics, "acct_1", 0);
    expect(n).toBeLessThanOrEqual(TALLY_MAX_POINTS);
    expect(a.points.length).toBe(n);

    const kills = a.of("sim.tally").filter((p) => p.blobs.metric === "kill");
    const drops = a.of("sim.tally").filter((p) => p.blobs.metric === "drop");
    // The excess folds into an "other" bucket per metric, and the top-amount kills survive.
    expect(kills.some((p) => p.blobs.k1 === "other")).toBe(true);
    expect(drops.some((p) => p.blobs.k1 === "other")).toBe(true);
    expect(kills.some((p) => p.blobs.k1 === "m299")).toBe(true);

    // Nothing is lost: the sum of every kill and drop amount is preserved.
    const sumKill = kills.reduce((s, p) => s + (p.doubles.amount ?? 0), 0);
    const sumDrop = drops.reduce((s, p) => s + (p.doubles.amount ?? 0), 0);
    expect(sumKill).toBe((300 * 301) / 2);
    expect(sumDrop).toBe(100);
  });

  it("keeps everything when the counters fit the cap", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        fold(events, _w, add) {
          for (const e of events) add("kill", String(e.monster), "normal", 1);
        },
      }),
    );
    tally.onEvents([ev("kill", { monster: "a" }), ev("kill", { monster: "b" })]);
    tally.commit(WORLD, 1, 1);
    const kills = flushed(tally)
      .of("sim.tally")
      .filter((p) => p.blobs.metric === "kill")
      .map((p) => p.blobs.k1)
      .sort((x, y) => x!.localeCompare(y!));
    expect(kills).toEqual(["a", "b"]);
  });
});

describe("due", () => {
  it("is false when empty, and true once the data is older than TALLY_FLUSH_MS", () => {
    const tally = new SimTally("classic", fakeHooks());
    expect(tally.due(0)).toBe(false);
    tally.onEvents([ev("kill", { monster: "x", rarity: "normal" })]);
    tally.commit(WORLD, 1, 1);
    expect(tally.due(1_000)).toBe(false);
    expect(tally.due(1_000 + TALLY_FLUSH_MS - 1)).toBe(false);
    expect(tally.due(1_000 + TALLY_FLUSH_MS)).toBe(true);
  });

  it("is true when there are more than TALLY_MAX_KEYS counters", () => {
    const tally = new SimTally(
      "classic",
      fakeHooks({
        fold(events, _w, add) {
          for (const e of events) add("kill", String(e.monster), "normal", 1);
        },
      }),
    );
    const events: GameEvent[] = [];
    for (let i = 0; i <= TALLY_MAX_KEYS; i++) events.push(ev("kill", { monster: `k${i}` }));
    tally.onEvents(events);
    tally.commit(WORLD, 1, 1);
    expect(tally.due(0)).toBe(true);
  });

  it("is reset by a flush", () => {
    const tally = new SimTally("classic", fakeHooks());
    tally.resync("desync");
    expect(tally.due(0)).toBe(false);
    expect(tally.due(TALLY_FLUSH_MS)).toBe(true);
    flushed(tally);
    expect(tally.due(10 * TALLY_FLUSH_MS)).toBe(false);
  });
});
