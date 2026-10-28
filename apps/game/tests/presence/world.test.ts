import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PRESENCE_WORLD,
  PRESENCE_WORLDS,
  presenceEntityId,
  presenceWorld,
  relayName,
  relayShard,
  worldOfChunk,
} from "../../src/shared/worlds.ts";
import { defaultWorld, placement, worldFromParam } from "../../src/server/presence/world.ts";

describe("presence world lookup", () => {
  it("plaza is the default world", () => {
    expect(DEFAULT_PRESENCE_WORLD).toBe("plaza");
    expect(presenceWorld(null)?.id).toBe("plaza");
    expect(presenceWorld(undefined)?.id).toBe("plaza");
    expect(defaultWorld().id).toBe("plaza");
  });

  it("finds known worlds by id", () => {
    expect(presenceWorld("classic-town")?.movement).toBe("client-pose");
    expect(presenceWorld("plaza")?.movement).toBe("server-path");
  });

  it("returns null for unknown ids, including inherited Object keys", () => {
    for (const id of ["nope", "", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(presenceWorld(id)).toBeNull();
    }
  });

  it("maps chunk names back to their world", () => {
    expect(worldOfChunk("classic:0:0")?.id).toBe("plaza");
    expect(worldOfChunk("classic-town:0:0")?.id).toBe("classic-town");
    expect(worldOfChunk("classic:9:9")).toBeNull();
  });

  it("gives plaza the phase-0 names and classic-town its own", () => {
    const plaza = PRESENCE_WORLDS.plaza!;
    const town = PRESENCE_WORLDS["classic-town"]!;
    expect(relayName("EU", plaza)).toBe("relay:EU:0");
    expect(relayName("EU", town)).toBe("relay:EU:classic-town:0");
    expect(presenceEntityId("acc", plaza)).toBe("acc:classic");
    expect(presenceEntityId("acc", town)).toBe("acc:classic-town");
  });

  it("classic-town is client-pose, unpersisted and 72 tiles square", () => {
    const town = PRESENCE_WORLDS["classic-town"]!;
    expect(town.map).toBeNull();
    expect(town.characterMode).toBeNull();
    expect(town.width).toBe(72);
    expect(town.height).toBe(72);
    expect(town.spawn.x).toBeLessThan(town.width);
    expect(town.spawn.y).toBeLessThan(town.height);
  });

  it("plaza keeps its CharacterDO and the town map", () => {
    const plaza = PRESENCE_WORLDS.plaza!;
    expect(plaza.characterMode).toBe("classic");
    expect(plaza.map).not.toBeNull();
    expect(plaza.chunk).toBe("classic:0:0");
  });
});

describe("worldFromParam and placement", () => {
  it("absent parameter is plaza; unknown or empty parameters are rejected", () => {
    expect(worldFromParam(null)?.id).toBe("plaza");
    expect(worldFromParam("classic-town")?.id).toBe("classic-town");
    expect(worldFromParam("")).toBeNull();
    expect(worldFromParam("moon-base")).toBeNull();
  });

  it("gives the relay and entity id of a player in a world", () => {
    const town = PRESENCE_WORLDS["classic-town"]!;
    expect(placement("NA", "acc-1", town)).toEqual({
      relay: `relay:NA:classic-town:${relayShard("acc-1", town)}`,
      entityId: "acc-1:classic-town",
    });
    expect(placement("NA", "acc-1", PRESENCE_WORLDS.plaza!)).toEqual({
      relay: "relay:NA:0",
      entityId: "acc-1:classic",
    });
  });
});
