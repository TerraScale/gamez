/** QA hooks of the classic client: URL parameters, the event probe and the gallery layout. */
import { describe, expect, it } from "vite-plus/test";
import { loadMode } from "@gamez/kernel";
import { mode, modules } from "../src/index.ts";
import { KIND } from "../src/types.ts";
import {
  countersSummary,
  defaultHeroName,
  EventProbe,
  normalizeClassId,
  readDebugParams,
  TickTotals,
} from "../src/client/debug.ts";
import {
  buildGallerySections,
  captionDy,
  cellBelowPx,
  cellReachable,
  cellTopPx,
  type CellReport,
  type GalleryCell,
  type GallerySection,
  GALLERY_ACTIONS,
  isReachable,
  layoutPage,
  pageCount,
  refineKind,
  rowOffsets,
  tallyCells,
} from "../src/client/gallery.ts";
import { splitMissingIds, summarisePerf } from "../../../tools/qa/src/analysis.ts";

describe("readDebugParams", () => {
  it("reads debug, seed, class, autostart and name", () => {
    expect(readDebugParams("?debug=1&seed=42&class=rogue&autostart=1&name=Ann")).toEqual({
      debug: true,
      seed: 42,
      classId: "classic.rogue",
      autostart: true,
      name: "Ann",
    });
    expect(readDebugParams("")).toEqual({
      debug: false,
      seed: null,
      classId: null,
      autostart: false,
      name: null,
    });
  });

  it("rejects seeds that are not positive 31-bit integers", () => {
    for (const s of ["0", "-3", "1.5", "abc", "4294967296"]) {
      expect(readDebugParams(`?seed=${s}`).seed).toBeNull();
    }
  });

  it("normalises class ids and builds valid default names", () => {
    expect(normalizeClassId("Warrior")).toBe("classic.warrior");
    expect(normalizeClassId("classic.sorcerer")).toBe("classic.sorcerer");
    expect(defaultHeroName("classic.sorcerer")).toBe("QA Sorcerer");
    expect(defaultHeroName("classic.sorcerer").length).toBeLessThanOrEqual(16);
  });
});

describe("EventProbe", () => {
  it("counts events, casts, effects and kills and keeps a bounded ring", () => {
    const p = new EventProbe();
    p.push(
      [
        { type: "classic.cast", skill: "classic.skill.cleave", effect: "fx.cleave" },
        { type: "classic.death", isHero: false },
        { type: "classic.death", isHero: true },
      ],
      7,
    );
    for (let i = 0; i < 100; i++) p.push([{ type: "classic.xp" }], 8 + i);
    expect(p.counts["classic.cast"]).toBe(1);
    expect(p.casts).toEqual({ "classic.skill.cleave": 1 });
    expect(p.effects).toEqual({ "fx.cleave": 1 });
    expect(p.slain).toBe(1);
    expect(p.heroDeaths).toBe(1);
    expect(p.ring.length).toBeLessThanOrEqual(60);
    p.reset();
    expect(p.ring).toEqual([]);
    expect(p.counts).toEqual({});
  });
});

describe("gallery sections", () => {
  const loaded = loadMode(mode, modules);
  const reg = loaded.registry;
  const sections = buildGallerySections(reg, ["tile.extra", "prop.extra"]);
  const byId = new Map(sections.map((s) => [s.id, s]));

  it("covers every class, monster, NPC and skill in every action", () => {
    expect(byId.get("heroes")?.cells.length).toBe(
      reg.all(KIND.class).length * GALLERY_ACTIONS.length,
    );
    expect(byId.get("monsters")?.cells.length).toBe(
      reg.all(KIND.monster).length * GALLERY_ACTIONS.length,
    );
    expect(byId.get("npcs")?.cells.length).toBe(reg.all(KIND.npc).length * GALLERY_ACTIONS.length);
    const skills = byId.get("skills")?.cells.filter((c) => c.kind === "effect") ?? [];
    expect(skills.length).toBe(reg.all(KIND.skill).length);
    expect(byId.get("tiles")?.cells.some((c) => c.ref === "tile.extra")).toBe(true);
    expect(byId.get("props")?.cells.some((c) => c.ref === "prop.extra")).toBe(true);
  });

  it("lays every page out inside its map, one cell per tile", () => {
    for (const s of sections) {
      for (let p = 0; p < pageCount(s); p++) {
        const l = layoutPage(s, p);
        const seen = new Set<number>();
        for (const c of l.placed) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThan(l.map.width);
          expect(c.y).toBeLessThan(l.map.height);
          seen.add(c.y * l.map.width + c.x);
        }
        expect(seen.size).toBe(l.placed.length);
        expect(l.map.ground.length).toBe(l.map.width * l.map.height);
      }
    }
  });
});

const galleryReg = loadMode(mode, modules).registry;

describe("gallery reachability and fallbacks", () => {
  it("plays only idle for NPCs; every action is reachable for units", () => {
    expect(isReachable("npc", "idle")).toBe(true);
    for (const a of ["walk", "attack", "cast", "hit", "death"] as const) {
      expect(isReachable("npc", a)).toBe(false);
      expect(isReachable("unit", a)).toBe(true);
    }
    expect(isReachable("npc", undefined)).toBe(true);
  });

  it("accepts cast and hit falling back to the attack clip, flags idle fallbacks", () => {
    const app = "unit.monster.husk";
    expect(refineKind("action-fallback", "cast", `${app}.attack.se`, app)).toBe("attack-fallback");
    expect(refineKind("action-fallback", "hit", `${app}.attack`, app)).toBe("attack-fallback");
    expect(refineKind("action-fallback", "cast", `${app}.idle.se`, app)).toBe("action-fallback");
    expect(refineKind("action-fallback", "death", `${app}.attack.se`, app)).toBe("action-fallback");
    expect(refineKind("action-fallback", "hit", null, app)).toBe("action-fallback");
    expect(refineKind("exact", "cast", `${app}.cast.se`, app)).toBe("exact");
    expect(refineKind("primitive", "cast", null, app)).toBe("primitive");
  });

  it("covers the fallback floor tile and the boss volley projectile", () => {
    const all = buildGallerySections(galleryReg, []);
    const tiles = all.find((s) => s.id === "tiles");
    expect(tiles?.cells.some((c) => c.ref === "tile.dungeon.floor")).toBe(true);
    const skills = all.find((s) => s.id === "skills");
    expect(skills?.cells.some((c) => c.kind === "projectile" && c.ref === "fx.volley")).toBe(true);
  });
});

describe("gallery tally (what the QA check counts as a gap)", () => {
  const cell = (over: Partial<CellReport>): CellReport => ({
    key: "k",
    section: "npcs",
    kind: "unit",
    title: "attack",
    ref: "unit.npc.smith",
    action: "attack",
    resolved: "unit.npc.smith.idle.s (action-fallback)",
    worst: "action-fallback",
    reachable: true,
    ...over,
  });

  it("classifies NPC attack, cast, hit and death as n/a, never as action fallbacks", () => {
    const npcs = (["attack", "cast", "hit", "death"] as const).map((a) =>
      cell({ key: `npc:${a}`, action: a, reachable: false, worst: "n/a" }),
    );
    const t = tallyCells(npcs);
    expect(t.actionFallbacks).toEqual([]);
    expect(t.problems).toEqual([]);
    expect(t.notPlayed).toBe(4);
  });

  it("keeps real gaps: a hero action that lands on idle is an action fallback", () => {
    const hero = cell({ section: "heroes", ref: "unit.hero.smith", kind: "unit" });
    const t = tallyCells([hero]);
    expect(t.actionFallbacks).toHaveLength(1);
    expect(t.notPlayed).toBe(0);
  });

  it("accepts cast and hit on the attack clip and counts them apart", () => {
    const t = tallyCells([
      cell({ action: "cast", worst: "attack-fallback", resolved: "x.attack.se (attack-fallback)" }),
      cell({ action: "hit", worst: "attack-fallback", resolved: "x.attack (attack-fallback)" }),
    ]);
    expect(t.attackFallbacks).toBe(2);
    expect(t.actionFallbacks).toEqual([]);
  });

  it("puts generic and missing art into problems and tallies every kind", () => {
    const t = tallyCells([
      cell({ worst: "generic", resolved: "unit.x (generic)" }),
      cell({ worst: "exact" }),
    ]);
    expect(t.problems).toHaveLength(1);
    expect(t.byKind).toEqual({ generic: 1, exact: 1 });
  });

  it("marks every NPC action other than idle unreachable in the real sections", () => {
    const real = buildGallerySections(galleryReg, []);
    const npcs = real.find((s) => s.id === "npcs");
    const heroes = real.find((s) => s.id === "heroes");
    expect(npcs?.cells.length).toBeGreaterThan(0);
    for (const c of npcs?.cells ?? []) expect(cellReachable(c)).toBe(c.action === "idle");
    for (const c of heroes?.cells ?? []) expect(cellReachable(c)).toBe(true);
  });
});

describe("gallery row layout", () => {
  const unit = (scale: number): GalleryCell => ({
    key: `u${scale}`,
    kind: "unit",
    title: "u",
    ref: "unit.x",
    action: "idle",
    entity: {
      name: "u",
      appearance: "unit.x",
      kind: "unit",
      moving: false,
      isSelf: false,
      scale,
    },
  });
  const section = (cells: GalleryCell[], extra: Partial<GallerySection> = {}): GallerySection => ({
    id: "t",
    title: "t",
    cols: 2,
    colStep: 2,
    rowStep: 4,
    rowsPerPage: 9,
    ground: "tile.stone",
    rowHeaders: null,
    colHeaders: ["a", "b"],
    cells,
    ...extra,
  });

  it("gives the row of a boss more room than the normal row after it, never less than rowStep", () => {
    const s = section([unit(100), unit(100), unit(170), unit(170), unit(100), unit(100)]);
    const off = rowOffsets(s, s.cells);
    expect(off).toHaveLength(3);
    const intoBoss = (off[1] ?? 0) - (off[0] ?? 0);
    const outOfBoss = (off[2] ?? 0) - (off[1] ?? 0);
    expect(intoBoss).toBeGreaterThan(outOfBoss);
    expect(outOfBoss).toBeGreaterThanOrEqual(s.rowStep);
    for (const o of off) expect(Number.isInteger(o)).toBe(true);
  });

  it("clears the column header with the first row, however tall the head", () => {
    const s = section([unit(170), unit(170)]);
    const [first] = rowOffsets(s, s.cells);
    // The column header text hangs 24 px below its anchor (tile row 0).
    expect((first ?? 0) * 32).toBeGreaterThanOrEqual(cellTopPx(unit(170)) + 24);
  });

  it("row headers reserve room for their caption lines", () => {
    const tile = (key: string): GalleryCell => ({ key, kind: "tile", title: key, ref: key });
    const plain = section([tile("a"), tile("b")], { rowHeaders: null });
    const headed = section([tile("a"), tile("b")], { rowHeaders: ["x"], colHeaders: null });
    expect(rowOffsets(headed, headed.cells)[0] ?? 0).toBeGreaterThan(
      rowOffsets(plain, plain.cells)[0] ?? 0,
    );
  });

  it("a page of bosses is taller than a page of normal units", () => {
    const normal = section([unit(100), unit(100), unit(100), unit(100)]);
    const bosses = section([unit(170), unit(170), unit(170), unit(170)]);
    expect(layoutPage(bosses, 0).heightPx).toBeGreaterThan(layoutPage(normal, 0).heightPx);
  });

  it("lays out every real section with integer row offsets and the pitch of its columns", () => {
    const real = buildGallerySections(galleryReg, ["tile.extra", "prop.extra"]);
    for (const s of real) {
      for (let p = 0; p < pageCount(s); p++) {
        const l = layoutPage(s, p);
        expect(l.rowOff.every((o) => Number.isInteger(o))).toBe(true);
        expect(l.pitchPx).toBe(s.colStep * 64);
        for (const h of l.headers) expect(h.y).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("gallery captions and effects", () => {
  it("places effect captions below a fixed-size effect box", () => {
    const effect: GalleryCell = {
      key: "e",
      kind: "effect",
      title: "e",
      ref: "fx.x",
      effectId: "fx.x",
    };
    const unitCell: GalleryCell = { key: "u", kind: "unit", title: "u", ref: "unit.x" };
    expect(captionDy(effect)).toBeGreaterThan(captionDy(unitCell));
    expect(cellBelowPx(effect)).toBeGreaterThan(cellBelowPx(unitCell));
  });
});

describe("cumulative counters (window.__gamez.counters)", () => {
  it("counts every event even after the ring has dropped it", () => {
    const p = new EventProbe();
    for (let i = 0; i < 100; i++) p.push([{ type: "classic.loot.picked" }], i);
    expect(p.counts["classic.loot.picked"]).toBe(100);
    expect(p.ring.length).toBe(60);
    expect(p.ringDropped).toBe(40);
    p.reset();
    expect(p.ringDropped).toBe(0);
    expect(p.counts).toEqual({});
  });

  it("carries the ticks of a replaced sim into the total", () => {
    const totals = new TickTotals();
    const a = {};
    const b = {};
    expect(totals.read(a, 5)).toBe(5);
    expect(totals.read(a, 9)).toBe(9);
    // A new sim starts at tick 0; the total keeps the 9 ticks of the old one.
    expect(totals.read(b, 3)).toBe(12);
    expect(totals.read(b, 7)).toBe(16);
  });

  it("summarises the sim, the totals and the probe without the ring", () => {
    const probe = new EventProbe();
    for (let i = 0; i < 70; i++) probe.push([{ type: "classic.area.changed" }], i);
    probe.push([{ type: "classic.death", isHero: false }], 70);
    const totals = new TickTotals();
    const sim = { tick: 40 };
    const c = countersSummary(sim, totals, probe);
    expect(c.tick).toBe(40);
    expect(c.ticksTotal).toBe(40);
    expect(c.events["classic.area.changed"]).toBe(70);
    expect(c.slain).toBe(1);
    expect(c.ringDropped).toBe(11);
  });
});

describe("harness analysis (tools/qa)", () => {
  it("keeps icon ids out of the art gaps", () => {
    const split = splitMissingIds(["unit.hero", "icon.item.sword", "icon.skill.cleave", "tile.x"]);
    expect(split.art).toEqual(["unit.hero", "tile.x"]);
    expect(split.icons).toEqual(["icon.item.sword", "icon.skill.cleave"]);
  });

  it("splits long frames and longtasks into boot and steady state", () => {
    const perf = summarisePerf({
      frames: [
        [1200, 150],
        [4000, 300],
        [6000, 120],
        [9000, 90],
      ],
      longtasks: [
        [800, 4200],
        [7000, 60],
      ],
    });
    expect(perf.installed).toBe(true);
    expect(perf.longFrames.boot).toEqual({ count: 2, max: 300 });
    expect(perf.longFrames.steady).toEqual({ count: 1, max: 120 });
    // The 4.2 s boot longtask must not leak into the steady-state maximum.
    expect(perf.longtasks.boot).toEqual({ count: 1, max: 4200 });
    expect(perf.longtasks.steady).toEqual({ count: 1, max: 60 });
  });

  it("does not count frame gaps that a harness screenshot caused", () => {
    // The gap [5700, 6000] overlaps the pause [5800, 6100]; the gap [8850, 9000] does not.
    const perf = summarisePerf(
      {
        frames: [
          [6000, 300],
          [9000, 150],
        ],
      },
      [[5800, 6100]],
    );
    expect(perf.excludedFrames).toBe(1);
    expect(perf.harnessPauses).toBe(1);
    expect(perf.longFrames.steady).toEqual({ count: 1, max: 150 });
    expect(perf.longFrames.boot).toEqual({ count: 0, max: 0 });
  });

  it("reports nothing measured when the probe is missing", () => {
    const perf = summarisePerf(null);
    expect(perf.installed).toBe(false);
    expect(perf.longFrames.steady.count).toBe(0);
  });
});
