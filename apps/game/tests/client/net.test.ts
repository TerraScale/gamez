import { describe, expect, it } from "vite-plus/test";
import { backoffDelay } from "../../src/client/net.ts";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    const top = () => 1;
    expect(backoffDelay(0, 500, 10_000, top)).toBe(500);
    expect(backoffDelay(1, 500, 10_000, top)).toBe(1000);
    expect(backoffDelay(3, 500, 10_000, top)).toBe(4000);
    expect(backoffDelay(10, 500, 10_000, top)).toBe(10_000);
  });

  it("applies full jitter", () => {
    expect(backoffDelay(3, 500, 10_000, () => 0)).toBe(0);
    expect(backoffDelay(3, 500, 10_000, () => 0.5)).toBe(2000);
  });
});
