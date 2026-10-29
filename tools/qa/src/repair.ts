/**
 * QA scenario: classic-repair (integration QA finding: no Idle or quests run ever
 * produced classic.repaired, because natural wear, 1 durability per 8 kills, never
 * gets low enough in a minute of play).
 *
 * `node tools/qa/src/run.ts classic-repair <class> [--viewport phone] [--url base]`
 *
 * A cheat hero (?debug=1&cheats=1) gets gold and plays Idle x8 until it is in the
 * dungeon past the voluntary trip cooldown (autoState.tripAt, 60 sim seconds after
 * the last town visit; repair trips wait for it too) and exploring (no fight). Then
 * the `wearGear: 0` cheat breaks its gear through the real wear path, and the run
 * checks that Idle goes to town (classic.auto.plan toTown, read from the event ring),
 * that the note is "repair" (a warning: a fight that starts right after the cheat may
 * end in a retreat first, whose town visit repairs too), that
 * the smith repairs (classic.repaired, cumulative counter), that every broken item
 * is whole again (window.__gamez.sim.gear) and that Idle goes back down.
 *
 * Shots: `in-dungeon`, `gear-broken`, `repaired`, `back-down`. data.repair holds the
 * gear before and after, the plan notes seen and the repaired events.
 */
import { classArg, startClassic, type Run } from "./run.ts";

type Runner = (run: Run) => Promise<void>;

interface Gear {
  slot: string;
  cur: number;
  max: number;
}

interface SimView {
  tick: number;
  depth: number;
  hero: { gold: number; dead: boolean } | null;
  autoState: { plan: string; tripAt?: number } | null;
  gear?: Gear[];
  lastEvents: { tick: number; type: string; plan?: string; note?: string; cost?: number }[];
}

type Result = { ok: boolean; error?: { code: string; message?: string } };

const READY_MS = 90_000;
const REPAIR_MS = 90_000;
const BACK_MS = 60_000;
const POLL_MS = 250;

const simOf = (run: Run): Promise<SimView> => run.page.evaluate<SimView>("window.__gamez.sim");
const repairedCount = (run: Run): Promise<number> =>
  run.page.evaluate<number>("window.__gamez.counters?.events?.['classic.repaired'] ?? 0");

async function classicRepair(run: Run): Promise<void> {
  const cls = classArg(run);
  await startClassic(run, cls, { cheats: true });
  const data: Record<string, unknown> = {};
  run.report.data.repair = data;
  const cheat = (payload: unknown): Promise<Result> =>
    run.page.evaluate<Result>(`window.__gamez.controls.cheat(${JSON.stringify(payload)})`);

  const gold = await cheat({ gold: 5_000 });
  run.check("cheat gold accepted", gold.ok, gold.error);
  const idle = await run.page.evaluate<Result>("window.__gamez.controls.setMode('idle')");
  run.check("Idle mode on", idle.ok, idle.error);
  await run.page.evaluate("window.__gamez.controls.setSpeed(8)");

  // In the dungeon, past the trip cooldown of the last town visit.
  let ready = true;
  try {
    await run.page.waitFor(
      "(() => { const s = window.__gamez.sim; return s.depth >= 1 && s.autoState != null && s.autoState.tripAt != null && s.tick > s.autoState.tripAt && s.autoState.plan === 'explore' && !s.hero?.dead; })()",
      READY_MS,
    );
  } catch {
    ready = false;
  }
  const s0 = await simOf(run);
  data.ready = { tick: s0.tick, depth: s0.depth, tripAt: s0.autoState?.tripAt ?? null };
  run.check("Idle is exploring the dungeon past the trip cooldown", ready, data.ready);
  if (!ready) return;
  await run.page.evaluate("window.__gamez.controls.setSpeed(2)");
  await run.shot("in-dungeon");

  const repaired0 = await repairedCount(run);
  const wear = await cheat({ wearGear: 0 });
  run.check("cheat wearGear accepted", wear.ok, wear.error);
  const s1 = await simOf(run);
  const broken = s1.gear ?? [];
  data.broken = broken;
  run.check(
    "every wearable item is broken",
    broken.length > 0 && broken.every((g) => g.cur === 0),
    broken,
  );
  await run.shot("gear-broken");

  // Idle: plan a repair trip, then the smith repairs.
  const notes: string[] = [];
  let lastTick = s1.tick - 1;
  let repairPlanned = false;
  let firstNote: string | null = null;
  let repairedAt = -1;
  const end = Date.now() + REPAIR_MS;
  while (Date.now() < end) {
    const s = await simOf(run);
    for (const e of s.lastEvents) {
      if (e.tick <= lastTick) continue;
      if (e.type === "classic.auto.plan" && e.plan === "toTown") {
        notes.push(e.note ?? "");
        firstNote ??= e.note ?? "";
        if (e.note?.startsWith("repair")) repairPlanned = true;
      }
    }
    lastTick = Math.max(lastTick, s.tick);
    if ((await repairedCount(run)) > repaired0) {
      repairedAt = s.tick;
      break;
    }
    await run.page.wait(POLL_MS);
  }
  data.toTownNotes = notes;
  run.check("Idle goes to town after the gear breaks (toTown)", firstNote !== null, notes);
  run.check(
    "the town trip is a repair trip (toTown: repair)",
    repairPlanned,
    notes,
    firstNote === "retreat",
  );
  run.check("the smith repairs (classic.repaired)", repairedAt >= 0, {
    before: repaired0,
    after: await repairedCount(run),
  });
  await run.page.wait(300);
  const s2 = await simOf(run);
  const after = s2.gear ?? [];
  data.after = after;
  const whole = broken.every((b) => {
    const g = after.find((a) => a.slot === b.slot);
    return g !== undefined && g.cur >= g.max - 2;
  });
  run.check("every broken item is whole again", whole, { broken, after });
  await run.shot("repaired");

  let back = true;
  try {
    await run.page.waitFor("window.__gamez.sim.depth >= 1", BACK_MS);
  } catch {
    back = false;
  }
  run.check("Idle goes back to the dungeon", back, { depth: (await simOf(run)).depth });
  if (back) await run.shot("back-down");
  await run.page.evaluate("window.__gamez.controls.setSpeed(1)");
}

export const REPAIR_RUNNERS: Record<string, Runner> = {
  "classic-repair": classicRepair,
};
