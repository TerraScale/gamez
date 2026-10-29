/**
 * Telemetry context (admin-dashboard.md §9, §11.5): the shell sets the token
 * and the running mode with an empty contentHash; the verified connection sets
 * the server's contentHash on join. Events must carry the real hash, not "".
 */
import { describe, expect, it } from "vite-plus/test";
import {
  setTelemetryContentHash,
  setTelemetryContext,
  telemetryContext,
} from "../../src/client/telemetry/index.ts";

describe("telemetry contentHash", () => {
  it("keeps the verified hash when the shell re-sets the same mode, in either order", () => {
    setTelemetryContext({ token: "t1", mode: "", contentHash: "" });
    setTelemetryContext({ token: "t1", mode: "classic", contentHash: "" });
    expect(telemetryContext().contentHash).toBe("");
    setTelemetryContentHash("classic", "abc123");
    expect(telemetryContext()).toEqual({ token: "t1", mode: "classic", contentHash: "abc123" });
    // A token refresh in the same mode keeps the hash.
    setTelemetryContext({ token: "t2", mode: "classic", contentHash: "" });
    expect(telemetryContext()).toEqual({ token: "t2", mode: "classic", contentHash: "abc123" });
  });

  it("drops the hash when the mode changes and takes an explicit hash", () => {
    setTelemetryContentHash("classic", "abc123");
    setTelemetryContext({ token: "t", mode: "steps", contentHash: "" });
    expect(telemetryContext().contentHash).toBe("");
    setTelemetryContext({ token: "t", mode: "steps", contentHash: "s9" });
    expect(telemetryContext().contentHash).toBe("s9");
  });

  it("a join that arrives before the shell's effect is kept", () => {
    setTelemetryContext({ token: "t", mode: "", contentHash: "" });
    setTelemetryContentHash("duel", "d1");
    setTelemetryContext({ token: "t", mode: "duel", contentHash: "" });
    expect(telemetryContext()).toEqual({ token: "t", mode: "duel", contentHash: "d1" });
  });

  it("ignores non-string input without throwing", () => {
    setTelemetryContentHash("classic", "ok");
    expect(() => setTelemetryContentHash(1 as unknown as string, "x")).not.toThrow();
    expect(telemetryContext().contentHash).toBe("ok");
  });
});
