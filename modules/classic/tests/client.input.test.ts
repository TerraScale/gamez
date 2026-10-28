/** Key map, mode cycling, speed steps, keyboard binding and pointer gestures (docs/design/classic.md §12.4). */
import type { PointerInfo } from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import {
  bindKeyboard,
  HOLD_REPEAT_MS,
  isTypingTarget,
  keyCommand,
  nextMode,
  PointerInput,
  type PointerCommand,
  type PointerPick,
  stepSpeed,
} from "../src/client/input.ts";

describe("key map", () => {
  it("maps number keys to bar slots and Q W E R to belt slots", () => {
    expect(keyCommand("1")).toEqual({ kind: "cast", slot: 0 });
    expect(keyCommand("6")).toEqual({ kind: "cast", slot: 5 });
    expect(keyCommand("q")).toEqual({ kind: "drink", slot: 0 });
    expect(keyCommand("Q")).toEqual({ kind: "drink", slot: 0 });
    expect(keyCommand("r")).toEqual({ kind: "drink", slot: 3 });
  });

  it("maps panel keys, Escape, minimap, automap and town portal", () => {
    expect(keyCommand("c")).toEqual({ kind: "panel", panel: "character" });
    expect(keyCommand("I")).toEqual({ kind: "panel", panel: "inventory" });
    expect(keyCommand("s")).toEqual({ kind: "panel", panel: "skills" });
    expect(keyCommand("l")).toEqual({ kind: "panel", panel: "quests" });
    expect(keyCommand("Escape")).toEqual({ kind: "closeAll" });
    expect(keyCommand("m")).toEqual({ kind: "minimap" });
    expect(keyCommand("Tab")).toEqual({ kind: "automap" });
    expect(keyCommand("t")).toEqual({ kind: "portal" });
  });

  it("maps Space to the mode cycle and +/- to speed", () => {
    expect(keyCommand(" ")).toEqual({ kind: "cycleMode" });
    expect(keyCommand("+")).toEqual({ kind: "speed", delta: 1 });
    expect(keyCommand("=")).toEqual({ kind: "speed", delta: 1 });
    expect(keyCommand("-")).toEqual({ kind: "speed", delta: -1 });
  });

  it("leaves unbound keys alone", () => {
    expect(keyCommand("x")).toBeNull();
    expect(keyCommand("7")).toBeNull();
    expect(keyCommand("Enter")).toBeNull();
  });
});

describe("modes and speeds", () => {
  it("cycles Manual -> Auto -> Idle -> Manual", () => {
    expect(nextMode("manual")).toBe("auto");
    expect(nextMode("auto")).toBe("idle");
    expect(nextMode("idle")).toBe("manual");
  });

  it("steps idle speed through 1, 2, 4, 8 and clamps at the ends", () => {
    expect(stepSpeed(1, 1)).toBe(2);
    expect(stepSpeed(4, 1)).toBe(8);
    expect(stepSpeed(8, 1)).toBe(8);
    expect(stepSpeed(4, -1)).toBe(2);
    expect(stepSpeed(1, -1)).toBe(1);
  });
});

describe("typing guard", () => {
  it("recognises form fields and editable content", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

interface FakeKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: unknown;
  prevented: boolean;
  preventDefault(): void;
}

function fakeKey(key: string, extra: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  const ev: FakeKeyEvent = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: "CANVAS" },
    prevented: false,
    preventDefault() {
      ev.prevented = true;
    },
    ...extra,
  };
  return ev;
}

describe("bindKeyboard", () => {
  function fakeWindow() {
    const listeners = new Set<(e: unknown) => void>();
    return {
      listeners,
      addEventListener(_type: string, l: (e: unknown) => void) {
        listeners.add(l);
      },
      removeEventListener(_type: string, l: (e: unknown) => void) {
        listeners.delete(l);
      },
      press(ev: FakeKeyEvent) {
        for (const l of listeners) l(ev);
      },
    };
  }

  it("forwards bound keys and prevents their default", () => {
    const win = fakeWindow();
    const got: unknown[] = [];
    bindKeyboard(win as unknown as Window, (cmd) => got.push(cmd));
    const ev = fakeKey("2");
    win.press(ev);
    expect(got).toEqual([{ kind: "cast", slot: 1 }]);
    expect(ev.prevented).toBe(true);
  });

  it("ignores modifier chords and keys typed into fields", () => {
    const win = fakeWindow();
    const got: unknown[] = [];
    bindKeyboard(win as unknown as Window, (cmd) => got.push(cmd));
    win.press(fakeKey("1", { ctrlKey: true }));
    win.press(fakeKey("1", { metaKey: true }));
    win.press(fakeKey("1", { target: { tagName: "INPUT" } }));
    win.press(fakeKey("x"));
    expect(got).toEqual([]);
  });

  it("unbinds on request", () => {
    const win = fakeWindow();
    const got: unknown[] = [];
    const off = bindKeyboard(win as unknown as Window, (cmd) => got.push(cmd));
    off();
    win.press(fakeKey("1"));
    expect(got).toEqual([]);
    expect(win.listeners.size).toBe(0);
  });
});

/** Ground pick table: a monster at (8.5, 5.5), loot at (4.5, 4.5), an NPC at (2.5, 2.5). */
function env() {
  const table: { x: number; y: number; pick: PointerPick }[] = [
    { x: 8.5, y: 5.5, pick: { kind: "unit", entity: 42 } },
    { x: 4.5, y: 4.5, pick: { kind: "loot", entity: 7 } },
    { x: 2.5, y: 2.5, pick: { kind: "npc", entity: 9 } },
  ];
  return {
    pick(x: number, y: number): PointerPick | null {
      for (const t of table) {
        if (Math.hypot(t.x - x, t.y - y) <= 0.8) return t.pick;
      }
      return null;
    },
  };
}

function pointer(
  kind: PointerInfo["kind"],
  x: number,
  y: number,
  extra: Partial<PointerInfo> = {},
): PointerInfo {
  return { kind, x, y, button: 0, shift: false, pointerType: "mouse", ...extra };
}

describe("PointerInput", () => {
  it("taps: walks on ground, attacks monsters, picks loot, talks to NPCs", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("tap", 3.7, 2.2));
    input.handle(pointer("tap", 8.6, 5.4));
    input.handle(pointer("tap", 4.4, 4.6));
    input.handle(pointer("tap", 2.5, 2.4));
    expect(got).toEqual([
      { kind: "move", x: 3, y: 2 },
      { kind: "attack", entity: 42, repeat: true },
      { kind: "pickup", entity: 7 },
      { kind: "interact", entity: 9 },
    ]);
  });

  it("shift tap stands still and casts slot 1 at the point", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("tap", 1.5, 1.5, { shift: true }));
    expect(got).toEqual([
      { kind: "cast", slot: 0, entity: 0, x: 384, y: 384, repeat: false, stand: true },
    ]);
  });

  it("right tap casts slot 2 at the monster under the pointer or the point", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("tap", 8.5, 5.5, { button: 2 }));
    input.handle(pointer("tap", 1.5, 1.5, { button: 2 }));
    expect(got).toEqual([
      { kind: "cast", slot: 1, entity: 42, x: 2176, y: 1408, repeat: false, stand: false },
      { kind: "cast", slot: 1, entity: 0, x: 384, y: 384, repeat: false, stand: false },
    ]);
  });

  it("hold repeats the ground move every 250 ms and follows the pointer", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("hold", 3.5, 3.5));
    expect(got).toHaveLength(1);
    input.update(HOLD_REPEAT_MS - 1);
    expect(got).toHaveLength(1);
    input.update(1);
    expect(got).toHaveLength(2);
    input.handle(pointer("move", 6.5, 6.5));
    input.update(HOLD_REPEAT_MS);
    expect(got[2]).toEqual({ kind: "move", x: 6, y: 6 });
  });

  it("hold on a monster keeps attacking it", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("hold", 8.5, 5.5));
    input.update(HOLD_REPEAT_MS);
    expect(got).toEqual([
      { kind: "attack", entity: 42, repeat: true },
      { kind: "attack", entity: 42, repeat: true },
    ]);
  });

  it("up ends the hold; non-left holds are ignored", () => {
    const got: PointerCommand[] = [];
    const input = new PointerInput(env(), (c) => got.push(c));
    input.handle(pointer("hold", 3.5, 3.5));
    input.handle(pointer("up", 3.5, 3.5));
    input.update(1000);
    expect(got).toHaveLength(1);
    expect(input.holding).toBe(false);
    input.handle(pointer("hold", 3.5, 3.5, { button: 2 }));
    expect(got).toHaveLength(1);
  });

  it("reports the monster under the pointer on move", () => {
    const hovered: number[] = [];
    const input = new PointerInput(
      env(),
      () => {},
      (entity) => hovered.push(entity),
    );
    input.handle(pointer("move", 8.5, 5.5));
    input.handle(pointer("move", 8.5, 5.6));
    input.handle(pointer("move", 0.5, 0.5));
    expect(hovered).toEqual([42, 0]);
    expect(input.hovered).toBe(0);
  });
});

describe("wave A panel keys", () => {
  it("maps N to talents and Y to achievements (any letter case)", () => {
    expect(keyCommand("n")).toEqual({ kind: "panel", panel: "talents" });
    expect(keyCommand("N")).toEqual({ kind: "panel", panel: "talents" });
    expect(keyCommand("y")).toEqual({ kind: "panel", panel: "achievements" });
    expect(keyCommand("Y")).toEqual({ kind: "panel", panel: "achievements" });
  });

  it("keeps the older bindings (no clash with N or Y)", () => {
    expect(keyCommand("c")).toEqual({ kind: "panel", panel: "character" });
    expect(keyCommand("l")).toEqual({ kind: "panel", panel: "quests" });
    expect(keyCommand("Tab")).toEqual({ kind: "automap" });
  });
});
