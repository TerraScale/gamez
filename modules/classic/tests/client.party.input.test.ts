/**
 * Party input and feedback (docs/design/party.md §10.4, §10.5): F1-F4, Tab / Shift+Tab (solo: the
 * automap), P, the backquote automap key, the key listener's Shift handling, the action a key sends,
 * the pointer tap on a downed member ("ally" = interact), and the feedback filter of follower events.
 */
import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import type { PartyMemberView, PartyView } from "../src/client/contract.ts";
import { feedbackFor, PARTY_TOAST_MS } from "../src/client/game.ts";
import type { Visual } from "../src/client/effects.ts";
import {
  PointerInput,
  bindKeyboard,
  keyCommand,
  partyKeyCall,
  type KeyCommand,
  type PointerCommand,
  type PointerEnv,
} from "../src/client/input.ts";
import { DEFAULT_PARTY_CONFIG } from "../src/resources.ts";

function fakeWindow() {
  const listeners = new Map<string, (e: unknown) => void>();
  return {
    win: {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    press(e: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; target: unknown }>) {
      const prevented = { value: false };
      const ev = {
        key: "",
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: {},
        preventDefault() {
          prevented.value = true;
        },
        ...e,
      };
      listeners.get("keydown")?.(ev);
      return prevented.value;
    },
  };
}

function member(entity: number, slot: number, controlled = false): PartyMemberView {
  return {
    entity,
    slot,
    key: `F${slot + 1}`,
    name: `M${slot}`,
    classId: "classic.warrior",
    className: "Warrior",
    appearance: "unit.hero.warrior",
    tint: 0xffffff,
    level: 5,
    xpPermille: 0,
    life: 10,
    lifeMax: 10,
    mana: 1,
    manaMax: 1,
    role: "front",
    dead: false,
    reviving: null,
    controlled,
    leader: controlled,
    founder: slot === 0,
    plan: "none",
    unspent: 0,
    statuses: [],
  };
}

function party(size: number, controlledSlot = 0): PartyView {
  const members = Array.from({ length: size }, (_, i) => member(10 + i, i, i === controlledSlot));
  return {
    members,
    slots: 4,
    maxMembers: 4,
    nextSlotPrice: null,
    nextSlotBossDepth: null,
    recruit: { level: 2, fee: 100, blocked: null },
    config: { ...DEFAULT_PARTY_CONFIG },
    gold: 0,
    inTown: true,
    partyAuto: false,
  };
}

describe("party keys", () => {
  it("F1..F4 take control of slots 0..3", () => {
    expect(keyCommand("F1")).toEqual({ kind: "control", slot: 0 });
    expect(keyCommand("F2")).toEqual({ kind: "control", slot: 1 });
    expect(keyCommand("F3")).toEqual({ kind: "control", slot: 2 });
    expect(keyCommand("F4")).toEqual({ kind: "control", slot: 3 });
    expect(keyCommand("F5")).toBeNull();
  });

  it("Tab cycles control with a party of two or more, Shift+Tab backwards", () => {
    expect(keyCommand("Tab", { partySize: 3 })).toEqual({ kind: "cycleControl", delta: 1 });
    expect(keyCommand("Tab", { partySize: 3, shift: true })).toEqual({
      kind: "cycleControl",
      delta: -1,
    });
    expect(keyCommand("Tab", { partySize: 2, shift: true })).toEqual({
      kind: "cycleControl",
      delta: -1,
    });
  });

  it("Tab is the automap when solo (with or without Shift)", () => {
    expect(keyCommand("Tab")).toEqual({ kind: "automap" });
    expect(keyCommand("Tab", { partySize: 1 })).toEqual({ kind: "automap" });
    expect(keyCommand("Tab", { partySize: 1, shift: true })).toEqual({ kind: "automap" });
  });

  it("the backquote key always toggles the automap", () => {
    expect(keyCommand("`")).toEqual({ kind: "automap" });
    expect(keyCommand("`", { partySize: 4 })).toEqual({ kind: "automap" });
    expect(keyCommand("Backquote", { partySize: 4 })).toEqual({ kind: "automap" });
  });

  it("P opens the party panel, in either case", () => {
    expect(keyCommand("p")).toEqual({ kind: "panel", panel: "party" });
    expect(keyCommand("P")).toEqual({ kind: "panel", panel: "party" });
  });

  it("the other bindings keep their meaning", () => {
    expect(keyCommand("1")).toEqual({ kind: "cast", slot: 0 });
    expect(keyCommand("Escape")).toEqual({ kind: "closeAll" });
    expect(keyCommand(" ")).toEqual({ kind: "cycleMode" });
  });

  it("the listener forwards Shift and the party size, prevents the default and skips typing", () => {
    const fw = fakeWindow();
    const got: KeyCommand[] = [];
    bindKeyboard(
      fw.win as unknown as Window,
      (c) => got.push(c),
      () => 3,
    );
    expect(fw.press({ key: "Tab", shiftKey: true })).toBe(true);
    expect(fw.press({ key: "F2" })).toBe(true);
    expect(fw.press({ key: "Tab", target: { tagName: "INPUT" } })).toBe(false);
    expect(fw.press({ key: "F3", ctrlKey: true })).toBe(false);
    expect(got).toEqual([
      { kind: "cycleControl", delta: -1 },
      { kind: "control", slot: 1 },
    ]);
  });

  it("without a party size the listener keeps Tab on the automap", () => {
    const fw = fakeWindow();
    const got: KeyCommand[] = [];
    bindKeyboard(fw.win as unknown as Window, (c) => got.push(c));
    fw.press({ key: "Tab" });
    expect(got).toEqual([{ kind: "automap" }]);
  });
});

describe("party key actions", () => {
  it("F-keys send classic.party.control for that member", () => {
    const p = party(3, 0);
    expect(partyKeyCall({ kind: "control", slot: 1 }, p)).toEqual({
      name: ACTION.partyControl,
      payload: { hero: 11 },
    });
  });

  it("nothing is sent for the controlled member, an empty slot, or no party", () => {
    const p = party(2, 0);
    expect(partyKeyCall({ kind: "control", slot: 0 }, p)).toBeNull();
    expect(partyKeyCall({ kind: "control", slot: 3 }, p)).toBeNull();
    expect(partyKeyCall({ kind: "control", slot: 1 }, null)).toBeNull();
  });

  it("Tab moves control forwards and wraps, Shift+Tab backwards", () => {
    const p = party(3, 2);
    expect(partyKeyCall({ kind: "cycleControl", delta: 1 }, p)).toEqual({
      name: ACTION.partyControl,
      payload: { hero: 10 },
    });
    const first = party(3, 0);
    expect(partyKeyCall({ kind: "cycleControl", delta: -1 }, first)).toEqual({
      name: ACTION.partyControl,
      payload: { hero: 12 },
    });
    expect(partyKeyCall({ kind: "cycleControl", delta: 1 }, party(1))).toBeNull();
  });

  it("other commands are not party commands", () => {
    expect(partyKeyCall({ kind: "automap" }, party(3))).toBeNull();
  });
});

describe("pointer on a downed member", () => {
  it("a tap on an ally pick interacts (which revives), it does not attack or walk", () => {
    const env: PointerEnv = { pick: () => ({ kind: "ally", entity: 42 }) };
    const out: PointerCommand[] = [];
    const pointer = new PointerInput(env, (c) => out.push(c));
    pointer.handle({ kind: "tap", x: 3.2, y: 4.7, button: 0, shift: false, pointerType: "mouse" });
    expect(out).toEqual([{ kind: "interact", entity: 42 }]);
  });

  it("hovering an ally is not a hovered monster", () => {
    const env: PointerEnv = { pick: () => ({ kind: "ally", entity: 42 }) };
    const pointer = new PointerInput(env, () => {});
    pointer.handle({ kind: "move", x: 3, y: 4, button: 0, shift: false, pointerType: "mouse" });
    expect(pointer.hovered).toBe(0);
  });
});

describe("feedback of party events", () => {
  const controlled = 1;
  const env = { controlled, nameOf: (e: number) => (e === 2 ? "Bo" : e === 1 ? "Ada" : "Hero") };
  const log: Visual = { kind: "log", logKind: "level", text: "You reached level 9", color: 0 };
  const toast: Visual = {
    kind: "toast",
    toastKind: "levelUp",
    title: "Level 9",
    body: "",
    ms: 7000,
  };
  const float: Visual = { kind: "float", x: 0, y: 0, text: "+5", color: 0, size: "m" };
  const panel: Visual = { kind: "panel", panel: "character" };
  const levelup = { kind: "effect", spec: { kind: "levelup", x: 0, y: 0, color: 0 } } as Visual;

  it("the controlled hero's events keep every visual", () => {
    const ev = { type: "classic.levelUp", level: 9 } as unknown as GameEvent;
    expect(feedbackFor(ev, [log, toast, float, panel, levelup], env)).toEqual([
      log,
      toast,
      float,
      panel,
      levelup,
    ]);
    const explicit = { type: "classic.levelUp", level: 9, hero: 1 } as unknown as GameEvent;
    expect(feedbackFor(explicit, [log, toast], env)).toEqual([log, toast]);
  });

  it("a follower's level up is a named log line and a small toast", () => {
    const ev = { type: "classic.levelUp", level: 9, hero: 2 } as unknown as GameEvent;
    const out = feedbackFor(ev, [log, toast, float, levelup], env);
    expect(out).toEqual([
      { kind: "log", logKind: "level", text: "Bo reached level 9", color: expect.any(Number) },
      {
        kind: "toast",
        toastKind: "info",
        title: "Bo",
        body: "Reached level 9",
        ms: PARTY_TOAST_MS,
      },
    ]);
  });

  it("a follower's other events keep the named log line, and no floats, panels or fanfares", () => {
    const ev = { type: "classic.skillLearned", hero: 2 } as unknown as GameEvent;
    const out = feedbackFor(ev, [log, toast, float, panel, levelup], env);
    expect(out).toEqual([
      { kind: "log", logKind: "level", text: "Bo: You reached level 9", color: 0 },
    ]);
  });

  it("a follower's death and respawn lines are left to the party events", () => {
    const ev = { type: "classic.hero.died", hero: 2 } as unknown as GameEvent;
    expect(feedbackFor(ev, [log, toast], env)).toEqual([]);
  });

  it("party events get their own lines (and their planned log and toast are dropped)", () => {
    const downed = { type: "classic.party.downed", hero: 2, name: "Bo" } as unknown as GameEvent;
    const out = feedbackFor(downed, [log, toast], env);
    expect(out.map((v) => v.kind)).toEqual(["log", "toast"]);
    expect(out[0]).toEqual({
      kind: "log",
      logKind: "system",
      text: "Bo is down",
      color: expect.any(Number),
    });
    const control = {
      type: "classic.party.control",
      hero: 2,
      previous: 1,
      reason: "death",
    } as unknown as GameEvent;
    const text = feedbackFor(control, [], env).map((v) => (v.kind === "toast" ? v.title : ""));
    expect(text).toContain("Control");
  });

  it("party slots and recruits read in words", () => {
    const slots = {
      type: "classic.party.slots",
      slots: 2,
      via: "gold",
      cost: 1500,
    } as unknown as GameEvent;
    const lines = feedbackFor(slots, [], env).filter((v) => v.kind === "log");
    expect(lines[0]).toMatchObject({ text: "Party slot 2 bought for 1500 gold" });
    const rec = {
      type: "classic.party.recruited",
      hero: 3,
      classId: "x",
      name: "Cy",
      slot: 2,
      level: 4,
      fee: 200,
    } as unknown as GameEvent;
    expect(feedbackFor(rec, [], env)[0]).toMatchObject({ text: "Cy joins the party (level 4)" });
  });
});
