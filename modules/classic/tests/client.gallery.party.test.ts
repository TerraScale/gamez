/** The gallery party page (?qa=gallery): the party identity outlines, a downed member and a summon (docs/design/party.md §10.6, §15). */
import { loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { KIND, type ClassProto, type MonsterProto } from "../src/types.ts";
import {
  buildGallerySections,
  GALLERY_ACTIONS,
  GALLERY_PARTY_SUMMON,
  layoutPage,
  pageCount,
} from "../src/client/gallery.ts";

describe("gallery: party page", () => {
  const reg = loadMode(mode, modules).registry;
  const sections = buildGallerySections(reg, []);

  it("lists five rows of six actions, paged three rows at a time", () => {
    const party = sections.find((s) => s.id === "party");
    expect(party).toBeDefined();
    expect(party!.ground).toBe("tile.grass");
    expect(party!.rowHeaders).toHaveLength(5);
    expect(party!.cells).toHaveLength(5 * GALLERY_ACTIONS.length);
    expect(pageCount(party!)).toBe(2);
    expect(() => layoutPage(party!, 0)).not.toThrow();
    expect(() => layoutPage(party!, 1)).not.toThrow();
  });

  it("shows self, party, downed, ally and a summon in the party ink", () => {
    const party = sections.find((s) => s.id === "party")!;
    const highlights = party.cells.map((c) => c.entity?.highlight);
    expect(new Set(highlights)).toEqual(new Set(["self", "party", "ally"]));
    const selfRow = party.cells.filter((c) => c.entity?.highlight === "self");
    expect(selfRow.every((c) => c.entity?.isSelf === true)).toBe(true);
    const sentry = reg.get<MonsterProto>(KIND.monster, GALLERY_PARTY_SUMMON);
    expect(sentry).toBeDefined();
    const summon = party.cells.filter((c) => c.ref === sentry!.appearance);
    expect(summon.length).toBe(GALLERY_ACTIONS.length);
    expect(summon.every((c) => c.entity?.name?.startsWith(sentry!.name))).toBe(true);
    expect(summon.every((c) => c.entity?.highlight === "party")).toBe(true);
  });

  it("draws the downed member in the dead pose in every column", () => {
    const party = sections.find((s) => s.id === "party")!;
    const downed = party.cells.filter((c) => c.entity?.subtitle === "Downed");
    expect(downed).toHaveLength(GALLERY_ACTIONS.length);
    expect(downed.every((c) => c.action === "death" && c.entity?.dead === true)).toBe(true);
    expect(downed.every((c) => c.entity?.highlight === "party")).toBe(true);
  });

  it("uses the class appearances of the registry for the members", () => {
    const party = sections.find((s) => s.id === "party")!;
    const classes = reg.all<ClassProto>(KIND.class);
    const first = party.cells[0]!;
    expect(first.entity?.appearance).toBe(classes[0]![1].appearance);
  });
});
