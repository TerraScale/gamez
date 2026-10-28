import { describe, expect, it } from "vite-plus/test";
import { GestureTracker, TAP_MS, TAP_SLACK_PX } from "../../src/client/render/gestures.ts";

function kinds(events: { kind: string }[]): string[] {
  return events.map((e) => e.kind);
}

describe("GestureTracker taps", () => {
  it("emits up then tap for a quick press without drag", () => {
    const g = new GestureTracker();
    expect(kinds(g.down(1, 100, 100, 0, 0, false, "mouse"))).toEqual(["down"]);
    expect(kinds(g.up(1, 101, 100, TAP_MS - 1))).toEqual(["up", "tap"]);
  });

  it("does not tap a press longer than 350 ms", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "mouse");
    expect(kinds(g.up(1, 100, 100, TAP_MS))).toEqual(["up"]);
  });

  it("does not tap a drag beyond the slack", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "mouse");
    const moves = g.move(1, 100 + TAP_SLACK_PX + 4, 100, 50, "mouse");
    expect(kinds(moves)).toEqual(["move"]);
    expect(kinds(g.up(1, 100 + TAP_SLACK_PX + 4, 100, 100))).toEqual(["up"]);
  });

  it("keeps the tap for small jitter inside the slack", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "touch");
    g.move(1, 100 + TAP_SLACK_PX - 1, 100, 10, "touch");
    expect(kinds(g.up(1, 100 + TAP_SLACK_PX - 1, 100, 20))).toEqual(["up", "tap"]);
  });

  it("carries button, shift and pointer type into the events", () => {
    const g = new GestureTracker();
    g.down(3, 10, 10, 0, 2, true, "pen");
    const [up, tap] = g.up(3, 10, 10, 5);
    expect(up).toMatchObject({ button: 2, shift: true, pointerType: "pen" });
    expect(tap?.kind).toBe("tap");
  });
});

describe("GestureTracker hold", () => {
  it("fires hold once after 350 ms and then suppresses the tap", () => {
    const g = new GestureTracker();
    g.down(1, 50, 50, 1000, 0, false, "touch");
    expect(g.tick(1000 + TAP_MS - 1)).toEqual([]);
    const held = g.tick(1000 + TAP_MS);
    expect(kinds(held)).toEqual(["hold"]);
    expect(g.tick(2000)).toEqual([]);
    expect(kinds(g.up(1, 50, 50, 2000))).toEqual(["up"]);
  });

  it("does not hold a dragged press", () => {
    const g = new GestureTracker();
    g.down(1, 50, 50, 0, 0, false, "mouse");
    g.move(1, 80, 50, 100, "mouse");
    expect(g.tick(TAP_MS + 100)).toEqual([]);
  });
});

describe("GestureTracker hover and pinch", () => {
  it("reports mouse hover moves without a press, but not touch moves", () => {
    const g = new GestureTracker();
    const hover = g.move(9, 5, 5, 0, "mouse");
    expect(hover).toEqual([
      {
        kind: "move",
        clientX: 5,
        clientY: 5,
        button: -1,
        shift: false,
        pointerType: "mouse",
        scale: 1,
      },
    ]);
    expect(g.move(9, 5, 5, 0, "touch")).toEqual([]);
  });

  it("turns a second pointer into a pinch with the distance ratio", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "touch");
    g.down(2, 140, 100, 0, 0, false, "touch");
    expect(g.pressed).toBe(2);
    const widen = g.move(2, 180, 100, 10, "touch");
    expect(kinds(widen)).toEqual(["pinch"]);
    // Distance went from 40 to 80 px.
    expect(widen[0]?.scale).toBeCloseTo(2, 9);
  });

  it("never taps the remaining finger after a pinch", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "touch");
    g.down(2, 140, 100, 0, 0, false, "touch");
    expect(kinds(g.up(2, 140, 100, 20))).toEqual(["up"]);
    expect(kinds(g.up(1, 100, 100, 30))).toEqual(["up"]);
  });

  it("cancel forgets a pointer without events", () => {
    const g = new GestureTracker();
    g.down(1, 100, 100, 0, 0, false, "touch");
    g.cancel(1);
    expect(g.pressed).toBe(0);
    expect(g.up(1, 100, 100, 10)).toEqual([]);
  });
});
