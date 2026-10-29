/**
 * classic.party revive and control (docs/design/party.md §4.2, §7.3): a revive
 * channel completes after reviveTicks and restores life; moving, taking damage,
 * leaving range or the target recovering cancels it; a downed member is revived
 * on arrival in town; the downed and wiped events fire on the tick of a death;
 * auto/idle hand control to the acting leader, manual does not.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { AreaTag, Dead, Life, Mana, Pos, Reviving, Wallet } from "../src/components.ts";
import { DEBUG_GRANT } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { pushCommand } from "../src/bus.ts";
import { tileCenter } from "../src/fixed.ts";
import { partyMembers, purseOf } from "../src/party/shared.ts";
import { RES, heroOf, type AreaState, type ControlState } from "../src/resources.ts";
import { partyProtoOf } from "../src/rules.ts";
import { openTestMap, setTestMap } from "../src/world/maps.ts";
import { useMap } from "./support/harness.ts";

const LOADED = loadMode({ ...mode }, [...modules, ...debugModules]);

function grant(sim: Sim, payload: Record<string, unknown>): void {
  const r = sim.dispatch(DEBUG_GRANT, payload, null);
  expect(r.ok, r.error?.message).toBe(true);
  sim.step(1);
}

/** A founder and a rogue (Rita) in town, after the first step. */
function duo(seed = 21): { sim: Sim; founder: number; rita: number } {
  const sim = createSim(LOADED, { seed });
  expect(
    sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, null).ok,
  ).toBe(true);
  sim.step(1);
  grant(sim, { bossesKilled: [4], gold: 2000 });
  const r = sim.dispatch(ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, null);
  expect(r.ok, r.error?.message).toBe(true);
  const founder = heroOf(sim.world);
  const rita = partyMembers(sim.world)[1]!;
  sim.world.update(purseOf(sim.world), Wallet, { gold: 0 });
  sim.step(1);
  return { sim, founder, rita };
}

/** The same party on an open dungeon level 1, the two heroes side by side. */
function dungeonDuo(seed = 21): { sim: Sim; founder: number; rita: number } {
  const out = duo(seed);
  useMap(out.sim.world, 1, openTestMap(32, 32, 1));
  setTestMap(out.sim.world, 0, openTestMap(32, 32, 0));
  placeAt(out.sim, out.founder, 5, 5);
  placeAt(out.sim, out.rita, 6, 5);
  out.sim.step(1);
  return out;
}

function placeAt(sim: Sim, e: number, tx: number, ty: number): void {
  sim.world.update(e, Pos, { x: tileCenter(tx), y: tileCenter(ty) });
  if (sim.world.has(e, AreaTag)) sim.world.update(e, AreaTag, { depth: area(sim) });
}

function area(sim: Sim): number {
  return sim.world.getResource<AreaState>(RES.area)?.depth ?? 0;
}

/** Downs a member now: zero life, Dead at the tick of the next step. */
function down(sim: Sim, e: number): void {
  sim.world.update(e, Life, { hp: 0 });
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
}

/** The codes of the events of `type` (classic.command.failed carries one). */
function codes(events: readonly GameEvent[], type: string): string[] {
  return events
    .filter((e) => e.type === type)
    .map((e) => {
      const code = (e as { code?: unknown }).code;
      return typeof code === "string" ? code : "";
    });
}

describe("revive channel", () => {
  it("completes after reviveTicks and brings the member back at reviveLifePct", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    const proto = partyProtoOf(sim.loaded.registry);
    pushCommand(sim.world, { op: "revive", target: rita });
    const started = sim.step(1);
    expect(started.some((e) => e.type === "classic.party.reviving")).toBe(true);
    expect(sim.world.has(founder, Reviving)).toBe(true);
    const until = sim.world.read(founder, Reviving).until;
    expect(until - sim.tick).toBeLessThanOrEqual(proto.reviveTicks);

    let revived: GameEvent | undefined;
    for (let i = 0; i < proto.reviveTicks + 5 && !revived; i++) {
      revived = sim.step(1).find((e) => e.type === "classic.party.revived");
    }
    expect(revived).toMatchObject({ type: "classic.party.revived", by: founder, via: "ally" });
    expect(sim.world.has(rita, Dead)).toBe(false);
    expect(sim.world.has(founder, Reviving)).toBe(false);
    const life = sim.world.read(rita, Life);
    expect(life.hp).toBe(Math.max(1, Math.floor((life.max * proto.reviveLifePct) / 100)));
    const mana = sim.world.read(rita, Mana);
    expect(mana.mp).toBe(Math.floor((mana.max * proto.reviveLifePct) / 100));
  });

  it("keeps the first timer when the same channel is asked again", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    pushCommand(sim.world, { op: "revive", target: rita });
    sim.step(1);
    const until = sim.world.read(founder, Reviving).until;
    sim.step(5);
    pushCommand(sim.world, { op: "revive", target: rita });
    sim.step(1);
    expect(sim.world.read(founder, Reviving).until).toBe(until);
  });

  it("is cancelled when the reviver takes damage", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    pushCommand(sim.world, { op: "revive", target: rita });
    sim.step(1);
    expect(sim.world.has(founder, Reviving)).toBe(true);
    const hp = sim.world.read(founder, Life).hp;
    sim.world.update(founder, Life, { hp: Math.max(1, hp - 20) });
    const events = sim.step(1);
    expect(events.some((e) => e.type === "classic.party.reviveCancelled")).toBe(true);
    expect(sim.world.has(founder, Reviving)).toBe(false);
    expect(sim.world.has(rita, Dead)).toBe(true);
  });

  it("is cancelled when the reviver moves", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    pushCommand(sim.world, { op: "revive", target: rita });
    sim.step(1);
    expect(sim.dispatch(ACTION.moveTo, { x: 9, y: 5 }, null).ok).toBe(true);
    let cancelled = false;
    for (let i = 0; i < 6 && !cancelled; i++) {
      cancelled = sim.step(1).some((e) => e.type === "classic.party.reviveCancelled");
    }
    expect(cancelled).toBe(true);
    expect(sim.world.has(founder, Reviving)).toBe(false);
    expect(sim.world.has(rita, Dead)).toBe(true);
  });

  it("is cancelled when the reviver walks out of range", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    pushCommand(sim.world, { op: "revive", target: rita });
    sim.step(1);
    placeAt(sim, founder, 25, 25);
    const events = sim.step(1);
    expect(events.some((e) => e.type === "classic.party.reviveCancelled")).toBe(true);
    expect(sim.world.has(founder, Reviving)).toBe(false);
  });

  it("fails the command with not_downed, too_far and not a member", () => {
    const { sim, founder, rita } = dungeonDuo();
    pushCommand(sim.world, { op: "revive", target: rita });
    expect(codes(sim.step(1), "classic.command.failed")).toEqual(["not_downed"]);

    down(sim, rita);
    placeAt(sim, founder, 25, 25);
    pushCommand(sim.world, { op: "revive", target: rita });
    expect(codes(sim.step(1), "classic.command.failed")).toEqual(["too_far"]);

    pushCommand(sim.world, { op: "revive", target: 999_999 });
    expect(codes(sim.step(1), "classic.command.failed")).toEqual(["not_member"]);
  });

  it("refuses to revive yourself", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    pushCommand(sim.world, { op: "revive", target: founder });
    expect(codes(sim.step(1), "classic.command.failed")).toEqual(["not_member"]);
  });
});

describe("town revive", () => {
  it("revives a downed member at full life when it arrives in town", () => {
    const { sim, founder, rita } = duo();
    expect(area(sim)).toBe(0);
    down(sim, rita);
    const events = sim.step(1);
    expect(sim.world.has(rita, Dead)).toBe(false);
    expect(events.some((e) => e.type === "classic.party.revived" && e.via === "town")).toBe(true);
    const life = sim.world.read(rita, Life);
    expect(life.hp).toBe(life.max);
    // Placed next to the acting leader, a few tiles away at most.
    const lp = sim.world.read(founder, Pos);
    const rp = sim.world.read(rita, Pos);
    expect(
      Math.abs((rp.x >> 8) - (lp.x >> 8)) + Math.abs((rp.y >> 8) - (lp.y >> 8)),
    ).toBeLessThanOrEqual(4);
  });
});

describe("downed and wiped events", () => {
  it("reports one downed member while another still stands", () => {
    const { sim, rita } = dungeonDuo();
    down(sim, rita);
    const events = sim.step(1);
    expect(events.filter((e) => e.type === "classic.party.downed")).toEqual([
      { type: "classic.party.downed", hero: rita, name: "Rita" },
    ]);
    expect(events.some((e) => e.type === "classic.party.wiped")).toBe(false);
  });

  it("reports wiped once when every member is down", () => {
    const { sim, founder, rita } = dungeonDuo();
    down(sim, rita);
    down(sim, founder);
    const events = sim.step(1);
    expect(events.filter((e) => e.type === "classic.party.wiped")).toHaveLength(1);
    expect(events.some((e) => e.type === "classic.party.downed")).toBe(false);
  });
});

describe("control auto-switch on death", () => {
  it("hands control to the acting leader in auto mode", () => {
    const { sim, founder, rita } = dungeonDuo();
    expect(sim.dispatch(ACTION.setControl, { mode: "auto" }, null).ok).toBe(true);
    down(sim, founder);
    const events = sim.step(1);
    expect(heroOf(sim.world)).toBe(rita);
    expect(
      events.some(
        (e) => e.type === "classic.party.control" && e.reason === "death" && e.hero === rita,
      ),
    ).toBe(true);
    expect(sim.world.getResource<ControlState>(RES.control)?.overrideUntil).toBe(0);
  });

  it("does not switch in manual mode", () => {
    const { sim, founder } = dungeonDuo();
    expect(sim.dispatch(ACTION.setControl, { mode: "manual" }, null).ok).toBe(true);
    expect(sim.world.getResource<ControlState>(RES.control)?.mode).toBe("manual");
    down(sim, founder);
    const events = sim.step(1);
    expect(heroOf(sim.world)).toBe(founder);
    expect(events.some((e) => e.type === "classic.party.control")).toBe(false);
  });

  it("does not switch when PartyConfig.autoSwitch is off", () => {
    const { sim, founder } = dungeonDuo();
    expect(sim.dispatch(ACTION.partyConfig, { config: { autoSwitch: false } }, null).ok).toBe(true);
    sim.dispatch(ACTION.setControl, { mode: "auto" }, null);
    down(sim, founder);
    sim.step(1);
    expect(heroOf(sim.world)).toBe(founder);
  });
});
