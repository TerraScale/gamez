import { describe, expect, it } from "vite-plus/test";
import { RESET_PROGRESS_WARNING, resetProgress } from "../src/client/hud/panels/SettingsPanel.tsx";

function fakeApi() {
  const calls: string[] = [];
  return {
    calls,
    api: { newGame: () => calls.push("newGame"), closeAll: () => calls.push("closeAll") },
  };
}

describe("reset progress", () => {
  it("asks for confirmation and does nothing when cancelled", () => {
    const { calls, api } = fakeApi();
    let asked = "";
    expect(resetProgress(api, (m) => ((asked = m), false))).toBe(false);
    expect(asked).toBe(RESET_PROGRESS_WARNING);
    expect(calls).toEqual([]);
  });

  it("closes the panels and starts a new game when confirmed", () => {
    const { calls, api } = fakeApi();
    expect(resetProgress(api, () => true)).toBe(true);
    expect(calls).toEqual(["closeAll", "newGame"]);
  });

  it("explains what is wiped and what is kept", () => {
    expect(RESET_PROGRESS_WARNING).toMatch(/hero/);
    expect(RESET_PROGRESS_WARNING).toMatch(/server/);
    expect(RESET_PROGRESS_WARNING).toMatch(/bank and cosmetics are kept/);
  });
});
