/**
 * "While you were away" card (docs/design/offline-idle.md §6): the planner that
 * builds the card from classic.offline.summary and its batch, the store, and the
 * markup. Rendered with react-dom/server; the Close action is the store call it wraps.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSim, loadMode, type GameEvent } from "@gamez/kernel";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { planEvent, type EffectEnv, type Visual } from "../src/client/effects.ts";
import { awayStore, type AwayView } from "../src/client/hudModel.ts";
import {
  AwaySummary,
  awayLines,
  dismissAway,
  UPKEEP_ATE_GOLD,
} from "../src/client/hud/widgets/AwaySummary.tsx";
import { mode, modules } from "../src/index.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const RATS = "classic.quest.rats_in_the_cellar";
const ASH = "classic.quest.ash_and_ember";
const WARDENS = "classic.quest.wardens_rest";
const CRYPT = "classic.quest.clear_the_crypt";

/** A classic.offline.summary event; the defaults are an uncapped 5 h 12 min rate-based grant. */
function summary(over: Record<string, unknown> = {}): GameEvent {
  return {
    type: "classic.offline.summary",
    ms: 5 * HOUR + 12 * MIN,
    awayMs: 5 * HOUR + 12 * MIN,
    capMs: 8 * HOUR,
    depth: 3,
    kills: 120,
    xp: 900,
    gold: 450,
    items: 4,
    levels: 2,
    xpPct: 20,
    goldPct: 100,
    itemPct: 100,
    source: "rate",
    ...over,
  };
}

/** The real classic content (quest names come from the registry). */
const LOADED = loadMode(mode, modules);

function envOf(batch: GameEvent[] = []): EffectEnv {
  const sim = createSim(LOADED, { seed: 1 });
  return {
    world: sim.world,
    registry: LOADED.registry,
    hero: 0,
    heroX: 0,
    heroY: 0,
    showDamageNumbers: false,
    manual: false,
    batch,
  };
}

function awayVisual(visuals: Visual[]): AwayView | null {
  const v = visuals.find((x): x is Extract<Visual, { kind: "away" }> => x.kind === "away");
  return v?.view ?? null;
}

function viewOf(ev: GameEvent, batch: GameEvent[] = []): AwayView {
  const view = awayVisual(planEvent(ev, envOf(batch)));
  if (!view) throw new Error("no away card planned");
  return view;
}

function show(view: AwayView): string {
  awayStore.set(view);
  return renderToStaticMarkup(<AwaySummary />);
}

beforeEach(() => {
  awayStore.set(null);
});

describe("away card: content", () => {
  it("renders every field of the grant", () => {
    const html = show(viewOf(summary()));
    expect(html).toContain("While you were away");
    expect(html).toContain("Away 5 h 12 min · credited 5 h 12 min");
    expect(html).toContain("120 kills");
    expect(html).toContain("+900 XP (20% offline rate)");
    expect(html).toContain("+450 gold");
    expect(html).toContain("4 items → stash");
    expect(html).toContain("+2 levels");
    expect(html).toContain("Measured from your Idle rate");
    expect(html).toContain(">Close</button>");
  });

  it("notes the cap when the absence was longer than the credited time", () => {
    const html = show(viewOf(summary({ awayMs: 10 * HOUR, ms: 8 * HOUR })));
    expect(html).toContain("Away 10 h · credited 8 h (capped at 8 h)");
  });

  it("has no cap note when nothing was cut", () => {
    const html = show(viewOf(summary()));
    expect(html).not.toContain("capped");
  });

  it("shows the xpPct from the event, not a hard-coded 20", () => {
    const view = viewOf(summary({ xpPct: 35, xp: 700 }));
    expect(view.xpPct).toBe(35);
    expect(show(view)).toContain("+700 XP (35% offline rate)");
  });

  it("notes the upkeep net on the gold line only when upkeep was paid", () => {
    expect(show(viewOf(summary({ upkeep: 130 })))).toContain("+450 gold (net of 130 upkeep)");
    expect(show(viewOf(summary({ upkeep: 0 })))).not.toContain("upkeep");
    expect(show(viewOf(summary()))).not.toContain("upkeep");
    const both = awayLines(viewOf(summary({ goldPct: 50, upkeep: 30 }))).lines;
    expect(both).toContain("+450 gold (50%) (net of 30 upkeep)");
  });

  it("shows the gold found next to the upkeep, and explains a gold grant of 0", () => {
    // A warrior whose online Idle spends more on potions than it finds (offline-idle.md §3).
    const zero = awayLines(viewOf(summary({ gold: 0, upkeep: 21621, found: 2424 }))).lines;
    expect(zero).toContain("+0 gold (found 2,424, net of 21,621 upkeep)");
    expect(zero).toContain(UPKEEP_ATE_GOLD);
    expect(show(viewOf(summary({ gold: 0, upkeep: 21621, found: 2424 })))).toContain(
      "cost what Idle finds here, as they do online",
    );
    // Some gold left: the found amount, no note.
    const net = awayLines(viewOf(summary({ gold: 320, upkeep: 130, found: 450 }))).lines;
    expect(net).toContain("+320 gold (found 450, net of 130 upkeep)");
    expect(net).not.toContain(UPKEEP_ATE_GOLD);
    // No upkeep (the model, or a hero that bought nothing): neither.
    const model = awayLines(viewOf(summary({ gold: 0, upkeep: 0, found: 0, source: "model" })));
    expect(model.lines).toContain("+0 gold");
    expect(model.lines).not.toContain(UPKEEP_ATE_GOLD);
    // An older server without `found`: the net only.
    expect(awayLines(viewOf(summary({ gold: 0, upkeep: 90 }))).lines).toContain(
      "+0 gold (net of 90 upkeep)",
    );
  });

  it("the effects log line mentions upkeep only when it is set", () => {
    const logText = (over: Record<string, unknown>) => {
      const log = planEvent(summary(over), envOf()).find((v) => v.kind === "log");
      return log?.kind === "log" ? log.text : "";
    };
    expect(logText({ upkeep: 60 })).toBe(
      "Offline 5 h 12 min: 120 kills, +900 XP (20% rate), +450 gold (net of 60 upkeep), 4 items",
    );
    expect(logText({})).not.toContain("upkeep");
    expect(logText({ upkeep: 60, found: 510 })).toContain(
      "+450 gold (found 510, net of 60 upkeep)",
    );
  });

  it("lists the offline rates in force: XP (the admin's factor), gold and items", () => {
    expect(show(viewOf(summary()))).toContain("Offline rates: XP 20% · gold 100% · items 100%");
    expect(show(viewOf(summary({ xpPct: 50, goldPct: 80 })))).toContain(
      "Offline rates: XP 50% · gold 80% · items 100%",
    );
  });

  it("shows the gold factor only when it is not 100 %", () => {
    expect(show(viewOf(summary({ goldPct: 50 })))).toContain("+450 gold (50%)");
    expect(show(viewOf(summary({ goldPct: 100 })))).not.toContain("(100%)");
  });

  it("hides items and levels when there are none, and uses the singular for one level", () => {
    const none = show(viewOf(summary({ items: 0, levels: 0 })));
    expect(none).not.toContain("stash");
    expect(none).not.toContain("level");
    expect(show(viewOf(summary({ levels: 1 })))).toContain("+1 level<");
  });

  it("says estimated for the model fallback", () => {
    const html = show(viewOf(summary({ source: "model" })));
    expect(html).toContain("Estimated: not enough Idle history yet");
    expect(html).not.toContain("Measured from your Idle rate");
  });

  it("builds quest lines from the same event batch", () => {
    const batch: GameEvent[] = [
      { type: "classic.quest.progress", quest: ASH, progress: 2, count: 5 },
      { type: "classic.quest.done", quest: RATS },
    ];
    const ev = summary();
    const view = viewOf(ev, [...batch, ev]);
    expect(view.quests).toEqual([
      { name: "Ash and Ember", text: "2/5", done: false },
      { name: "Rats in the Cellar", text: "complete", done: true },
    ]);
    expect(view.questsMore).toBe(0);
    const html = show(view);
    expect(html).toContain("Ash and Ember: 2/5");
    expect(html).toContain("Rats in the Cellar: done, turn in at the quest giver");
    expect(html).not.toContain("Rats in the Cellar: complete");
    expect(html).toContain('aria-label="Quest progress"');
  });

  it("keeps the last state of a quest and shows at most three lines", () => {
    const batch: GameEvent[] = [
      { type: "classic.quest.progress", quest: ASH, progress: 1, count: 5 },
      { type: "classic.quest.progress", quest: ASH, progress: 4, count: 5 },
      { type: "classic.quest.progress", quest: RATS, progress: 3, count: 4 },
      { type: "classic.quest.done", quest: WARDENS },
      { type: "classic.quest.progress", quest: CRYPT, progress: 0, count: 2 },
    ];
    const ev = summary();
    const view = viewOf(ev, [...batch, ev]);
    expect(view.quests.map((q) => q.text)).toEqual(["4/5", "3/4", "complete"]);
    expect(view.questsMore).toBe(1);
    expect(awayLines(view).quests).toEqual([
      "Ash and Ember: 4/5",
      "Rats in the Cellar: 3/4",
      "The Warden's Rest: done, turn in at the quest giver",
      "and 1 more",
    ]);
  });

  it("a quest done offline reads as turn-in-later, a running one keeps its progress", () => {
    const batch: GameEvent[] = [
      { type: "classic.quest.progress", quest: ASH, progress: 3, count: 5 },
      { type: "classic.quest.done", quest: RATS },
    ];
    const ev = summary();
    const lines = awayLines(viewOf(ev, [...batch, ev])).quests;
    expect(lines).toEqual([
      "Ash and Ember: 3/5",
      "Rats in the Cellar: done, turn in at the quest giver",
    ]);
  });

  it("has no quest lines when the summary arrives alone", () => {
    expect(viewOf(summary()).quests).toEqual([]);
  });

  it("keeps the log line with the rate and drops the long toast", () => {
    const visuals = planEvent(summary(), envOf());
    const logs = visuals.filter((v) => v.kind === "log");
    expect(logs).toHaveLength(1);
    const text = logs[0]?.kind === "log" ? logs[0].text : "";
    expect(text).toBe("Offline 5 h 12 min: 120 kills, +900 XP (20% rate), +450 gold, 4 items");
    expect(visuals.some((v) => v.kind === "toast")).toBe(false);
  });
});

describe("away card: visibility and dismissal", () => {
  it("shows nothing for a zero grant", () => {
    const visuals = planEvent(summary({ ms: 0, awayMs: 30_000, kills: 0 }), envOf());
    expect(visuals).toEqual([]);
    expect(awayStore.getSnapshot()).toBeNull();
    awayStore.set(null);
    expect(renderToStaticMarkup(<AwaySummary />)).toBe("");
  });

  it("renders nothing while the store is empty", () => {
    expect(renderToStaticMarkup(<AwaySummary />)).toBe("");
  });

  it("Close hides the card", () => {
    show(viewOf(summary()));
    expect(awayStore.getSnapshot()).not.toBeNull();
    dismissAway();
    expect(awayStore.getSnapshot()).toBeNull();
    expect(renderToStaticMarkup(<AwaySummary />)).toBe("");
  });

  it("fits a 375 px phone: 16 px gutter, card at most the viewport minus the gutters, 44 px Close", () => {
    const html = show(viewOf(summary()));
    expect(html).toContain("padding:0 16px");
    expect(html).toContain("width:min(360px, 100%)");
    expect(html).toContain("height:44px");
  });

  it("a new grant replaces the previous card", () => {
    show(viewOf(summary({ kills: 10 })));
    const second = show(viewOf(summary({ kills: 77 })));
    expect(second).toContain("77 kills");
    expect(second).not.toContain("10 kills");
  });
});
