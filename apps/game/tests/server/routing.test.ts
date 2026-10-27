import { describe, expect, it } from "vite-plus/test";
import { relayLocation } from "../../src/server/routing.ts";

describe("relayLocation", () => {
  it("maps continents to location hints", () => {
    expect(relayLocation("SA")).toBe("sam");
    expect(relayLocation("EU")).toBe("weur");
    expect(relayLocation("AF")).toBe("afr");
    expect(relayLocation("AS")).toBe("apac");
    expect(relayLocation("OC")).toBe("oc");
  });

  it("splits North America by longitude", () => {
    expect(relayLocation("NA", -122)).toBe("wnam");
    expect(relayLocation("NA", -74)).toBe("enam");
    expect(relayLocation("NA")).toBe("enam");
  });

  it("omits the hint for unknown continents", () => {
    expect(relayLocation("XX")).toBeUndefined();
    expect(relayLocation("AN")).toBeUndefined();
  });
});
