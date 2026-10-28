/**
 * Quest state survives every persistence path and replays on the server
 * (docs/design/classic.md §16, wave-B.md §2). Covers:
 *  (a) the local save: accepted, done-not-turned-in and completed quests
 *      round-trip through JSON into a fresh sim with equal QuestState and hash;
 *  (b) a recorded action log (interact, acceptQuest, kills by auto play,
 *      townPortal, completeQuest) replays through replaySegment to the live
 *      hashes, with every quest action accepted and none server-only;
 *  (c) an acceptQuest made far from the giver is rejected with the same code on
 *      both sides and leaves the hash unchanged.
 */
import {
  createSim,
  loadMode,
  replaySegment,
  SegmentRecorder,
  type RecordedSegment,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { Npc, Pos } from "../src/components.ts";
import { classicClientDriven, classicSpeedOf } from "../src/platform/policy.ts";
import { createSaveStore, DEFAULT_SETTINGS, type KeyValueStorage } from "../src/client/persist.ts";
import { SYNC_ACTOR } from "../src/client/sync/server-sync.ts";
import { areaOf, questsOf, type QuestState } from "../src/resources.ts";

const SEED = 4242;
const RATS = "classic.quest.rats_in_the_cellar";
const HALE = "classic.npc.captain_hale";
const loaded = loadMode(mode, modules);

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A new hero in manual control, stepped once so the world is populated. */
function freshSim(seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Quester" }, null).ok,
  ).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  sim.step(2);
  return sim;
}

function haleEntity(sim: Sim): number {
  for (const e of sim.world.query(Npc, Pos)) if (sim.world.read(e, Npc).proto === HALE) return e;
  throw new Error("no Captain Hale in town");
}

/** Walks the hero to Captain Hale with classic.interact (the same intent the NPC click sends). */
function walkToHale(sim: Sim): void {
  const r = sim.dispatch("classic.interact", { target: haleEntity(sim) }, null);
  expect(r.ok).toBe(true);
  for (let i = 0; i < 40; i++) sim.step(10);
}

/** Auto play until `done` (or stop) holds; returns false when the budget ran out. */
function autoUntil(sim: Sim, done: (q: QuestState) => boolean, maxTicks: number): boolean {
  if (sim.world.getResource<{ mode: string }>("classic.control")?.mode !== "auto") {
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  }
  for (let t = 0; t < maxTicks; t++) {
    if (done(questsOf(sim.world))) return true;
    sim.step(1);
  }
  return done(questsOf(sim.world));
}

function roundTripSave(sim: Sim): Sim {
  const storage = new MemoryStorage();
  const store = createSaveStore(storage);
  const ok = store.save({
    v: 1,
    savedAt: 1_700_000_000_000,
    snapshot: sim.snapshot(),
    settings: { ...DEFAULT_SETTINGS },
    modules: sim.loaded.modules.map((m) => m.id),
  });
  expect(ok).toBe(true);
  const rec = store.load(loaded.contentHash);
  expect(rec).not.toBeNull();
  return createSim(loaded, { seed: SEED, from: rec!.snapshot });
}

describe("quest persistence: local save", () => {
  it("accepted quest with partial progress round-trips with equal state and hash", () => {
    const sim = freshSim();
    walkToHale(sim);
    expect(sim.dispatch("classic.acceptQuest", { quest: RATS }, null).ok).toBe(true);
    expect(autoUntil(sim, (q) => q.active.some((a) => a.id === RATS && a.progress > 0), 6000)).toBe(
      true,
    );
    const back = roundTripSave(sim);
    expect(questsOf(back.world)).toEqual(questsOf(sim.world));
    expect(back.hash()).toBe(sim.hash());
    // Continues identically.
    sim.step(300);
    back.step(300);
    expect(back.hash()).toBe(sim.hash());
  }, 120_000);

  it("done-but-not-turned-in quest round-trips", () => {
    const sim = freshSim();
    walkToHale(sim);
    expect(sim.dispatch("classic.acceptQuest", { quest: RATS }, null).ok).toBe(true);
    // Stop on the tick the quest becomes done (before auto turns it in).
    expect(autoUntil(sim, (q) => q.active.some((a) => a.id === RATS && a.done), 20000)).toBe(true);
    const q = questsOf(sim.world);
    expect(q.active).toEqual([{ id: RATS, progress: 20, done: true }]);
    expect(q.completed).toEqual([]);
    const back = roundTripSave(sim);
    expect(questsOf(back.world)).toEqual(q);
    expect(back.hash()).toBe(sim.hash());
  }, 120_000);

  it("completed quest round-trips and stays completed", () => {
    const sim = freshSim();
    walkToHale(sim);
    expect(sim.dispatch("classic.acceptQuest", { quest: RATS }, null).ok).toBe(true);
    expect(autoUntil(sim, (q) => q.completed.includes(RATS), 30000)).toBe(true);
    const back = roundTripSave(sim);
    expect(questsOf(back.world)).toEqual(questsOf(sim.world));
    expect(questsOf(back.world).completed).toEqual([RATS]);
    expect(back.hash()).toBe(sim.hash());
    // A completed quest cannot be accepted again, on either copy.
    expect(back.dispatch("classic.acceptQuest", { quest: RATS }, null).error?.code).toBe(
      "quest_state",
    );
  }, 120_000);
});

describe("quest persistence: server replay", () => {
  it("a recorded log with interact, acceptQuest, kills and completeQuest replays to the live hashes", () => {
    const live = freshSim();
    const rec = new SegmentRecorder(0);
    // The setup inputs of freshSim are recorded too: a replay starts from tick 0.
    rec.record(0, "classic.newHero", { classId: "classic.warrior", name: "Quester" });
    rec.record(0, "classic.setControl", { mode: "manual" });
    const segs: RecordedSegment[] = [];
    const cut = () => {
      const s = rec.cut(live);
      if (s) segs.push(s);
    };
    const act = (name: string, payload: unknown): boolean => {
      const res = live.dispatch(name, payload, SYNC_ACTOR);
      if (res.ok) rec.record(live.tick, name, payload);
      return res.ok;
    };
    // The freshSim steps (2 ticks) are inside segment 0; cut after them.
    cut();

    expect(act("classic.interact", { target: haleEntity(live) })).toBe(true);
    for (let i = 0; i < 40; i++) live.step(10);
    cut();
    expect(act("classic.acceptQuest", { quest: RATS })).toBe(true);
    live.step(1);
    cut();

    expect(act("classic.setControl", { mode: "auto" })).toBe(true);
    live.step(1);
    cut();
    // Auto play kills 20 gnawlings; the quest turns done in the dungeon.
    const isDone = (q: QuestState) => q.active.some((a) => a.id === RATS && a.done);
    expect(autoUntil(live, isDone, 20000)).toBe(true);
    // Auto walks back to town (the quest trip). Take over on arrival, before it reaches Hale.
    for (let t = 0; t < 6000 && areaOf(live.world).depth !== 0; t++) {
      live.step(1);
      if (t % 50 === 49) cut();
    }
    expect(areaOf(live.world).depth).toBe(0);
    expect(isDone(questsOf(live.world))).toBe(true);
    cut();
    // Explicit turn-in: manual control, walk to Hale (recorded), completeQuest.
    expect(act("classic.setControl", { mode: "manual" })).toBe(true);
    live.step(1);
    cut();
    expect(act("classic.interact", { target: haleEntity(live) })).toBe(true);
    for (let i = 0; i < 40; i++) live.step(10);
    cut();
    expect(isDone(questsOf(live.world))).toBe(true);
    expect(act("classic.completeQuest", { quest: RATS })).toBe(true);
    live.step(1);
    cut();

    const q = questsOf(live.world);
    expect(q.completed).toEqual([RATS]);
    expect(q.active).toEqual([]);

    // Server side: a fresh sim of the same seed verifies every segment in order.
    const server = createSim(loaded, { seed: SEED });
    for (const seg of segs) {
      const out = replaySegment(server, seg, {
        actor: SYNC_ACTOR,
        maxTicks: 1_000_000,
        maxInputs: 1_000_000,
        serverOnly: new Set(classicClientDriven.serverOnlyActions),
        speedOf: classicSpeedOf,
        maxSpeed: classicClientDriven.maxSpeed,
        expectHash: seg.hash,
      });
      expect(out.ok, out.ok ? "" : `${out.code}: ${out.message}`).toBe(true);
    }
    expect(server.tick).toBe(live.tick);
    expect(server.hash()).toBe(live.hash());
    expect(questsOf(server.world)).toEqual(q);
  }, 120_000);
});

describe("quest rejection is deterministic", () => {
  it("acceptQuest far from the giver is rejected, leaves the hash unchanged and is not recorded", () => {
    const sim = freshSim();
    const before = sim.hash();
    const res = sim.dispatch("classic.acceptQuest", { quest: RATS }, SYNC_ACTOR);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("too_far");
    expect(sim.hash()).toBe(before);
    expect(questsOf(sim.world)).toEqual({ active: [], completed: [] });
  });

  it("the server replay of the same forged segment fails with the same code", () => {
    const seg = {
      fromTick: 0,
      toTick: 5,
      inputs: [
        {
          tick: 0,
          name: "classic.newHero",
          payload: { classId: "classic.warrior", name: "Quester" },
        },
        { tick: 0, name: "classic.setControl", payload: { mode: "manual" } },
        { tick: 2, name: "classic.acceptQuest", payload: { quest: RATS } },
      ],
      hash: "",
    };
    const opts = {
      actor: SYNC_ACTOR,
      maxTicks: 1000,
      maxInputs: 100,
      serverOnly: new Set(classicClientDriven.serverOnlyActions),
    };
    const a = replaySegment(createSim(loaded, { seed: SEED }), seg, opts);
    const b = replaySegment(createSim(loaded, { seed: SEED }), seg, opts);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.code).toBe("input_rejected");
    expect(a.message).toContain("too_far");
    expect(b.code).toBe(a.code);
    expect(b.message).toBe(a.message);
  });

  it("completeQuest before the quest is done is rejected and leaves the hash unchanged", () => {
    const sim = freshSim();
    walkToHale(sim);
    expect(sim.dispatch("classic.acceptQuest", { quest: RATS }, null).ok).toBe(true);
    const before = sim.hash();
    const res = sim.dispatch("classic.completeQuest", { quest: RATS }, SYNC_ACTOR);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("quest_state");
    expect(sim.hash()).toBe(before);
  });

  it("quest actions are client-dispatchable (not server-only)", () => {
    const serverOnly = new Set<string>(classicClientDriven.serverOnlyActions);
    expect(serverOnly.has("classic.acceptQuest")).toBe(false);
    expect(serverOnly.has("classic.completeQuest")).toBe(false);
    expect(serverOnly.has("classic.interact")).toBe(false);
  });
});
