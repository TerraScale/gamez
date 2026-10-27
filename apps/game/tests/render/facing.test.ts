import { describe, expect, it } from "vite-plus/test";
import { facingFromDelta } from "../../src/client/render/facing.ts";

describe("facingFromDelta", () => {
  it("maps the 8 tile-axis deltas to their iso screen directions", () => {
    expect(facingFromDelta(1, 0)).toBe("se");
    expect(facingFromDelta(0, 1)).toBe("sw");
    expect(facingFromDelta(-1, 0)).toBe("nw");
    expect(facingFromDelta(0, -1)).toBe("ne");
    expect(facingFromDelta(1, 1)).toBe("s");
    expect(facingFromDelta(-1, -1)).toBe("n");
    expect(facingFromDelta(1, -1)).toBe("e");
    expect(facingFromDelta(-1, 1)).toBe("w");
  });

  it("uses the direction, not the length, of the delta", () => {
    expect(facingFromDelta(5, 5)).toBe("s");
    expect(facingFromDelta(-0.1, -0.1)).toBe("n");
    expect(facingFromDelta(2, -1)).toBe("e");
    expect(facingFromDelta(-2, 1)).toBe("w");
  });

  it("faces south for a zero delta", () => {
    expect(facingFromDelta(0, 0)).toBe("s");
  });
});
