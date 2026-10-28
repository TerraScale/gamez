/**
 * Regression tests for the wave A browser QA findings fixed by the final pass:
 * touch taps open the item sheet instead of equipping, the sheet carries the
 * full item details, a rift death keeps the gold (toast text), the damage
 * table never runs its headers together, and the gallery gives the rift
 * guardians boss-sized rows next to the bosses.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { buildHud } from "../src/client/hudModel.ts";
import { bagTapAction } from "../src/client/hud/panels/InventoryPanel.tsx";
import { DpsTable } from "../src/client/hud/panels/CharacterPanel.tsx";
import { ItemDetails } from "../src/client/hud/widgets/Tooltip.tsx";
import { deathLossText } from "../src/client/effects.ts";
import { buildGallerySections, cellTopPx, type GalleryCell } from "../src/client/gallery.ts";
import { mode, modules } from "../src/index.ts";
import type { DpsView } from "../src/client/contract.ts";
import { itemOf, itemsSim, OAK_STAFF, setBag, spawnHero } from "./model.items.fixture.ts";

describe("bag taps (QA major: a phone tap equipped the item without showing it)", () => {
  it("a first touch tap opens the item sheet, a second one equips", () => {
    expect(bagTapAction({ moving: false, pointerType: "touch", sheetOpen: false })).toBe("details");
    expect(bagTapAction({ moving: false, pointerType: "touch", sheetOpen: true })).toBe("equip");
  });

  it("mouse, pen and keyboard clicks still equip at once", () => {
    for (const pointerType of ["mouse", "pen", ""]) {
      expect(bagTapAction({ moving: false, pointerType, sheetOpen: false })).toBe("equip");
    }
  });

  it("a tap while moving an item finishes the move, whatever the pointer", () => {
    expect(bagTapAction({ moving: true, pointerType: "touch", sheetOpen: false })).toBe("move");
    expect(bagTapAction({ moving: true, pointerType: "mouse", sheetOpen: true })).toBe("move");
  });

  it("the item sheet shows the same details as the tooltip (kind, set block, comparison)", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world, { level: 10 });
    setBag(sim.world, hero, [
      itemOf(7, "test.item.sword", { rarity: "set", set: OAK_STAFF, name: "Oak Staff" }),
    ]);
    const hud = buildHud(sim.world, sim.loaded.registry, {
      tick: 1,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    const item = hud.inventory.items[0]?.item;
    expect(item).toBeDefined();
    const markup = renderToStaticMarkup(<ItemDetails item={item!} isWorn={false} />);
    expect(markup).toContain("Oak Staff");
    expect(markup).toContain("ilvl");
    expect(markup).toContain("Value");
    expect(markup).toContain(`data-testid="tooltip-set"`);
  });
});

describe("death toast text", () => {
  it("names only what was lost (a rift death keeps the gold)", () => {
    expect(deathLossText(100, 2)).toBe("Lost 100 gold and 2 XP");
    expect(deathLossText(0, 2)).toBe("Lost 2 XP");
    expect(deathLossText(5, 0)).toBe("Lost 5 gold");
    expect(deathLossText(0, 0)).toBe("Nothing was lost");
  });
});

describe("damage table (QA minor: 'CastsDPSMana' ran together in a narrow panel)", () => {
  it("keeps a gap before every numeric header and never wraps them", () => {
    const dps: DpsView = {
      skills: [
        {
          skill: "s",
          name: "Strike",
          avgHit: 10,
          perSecond: 1.5,
          dps: 15,
          manaPerSecond: 0,
        },
      ],
      best: 15,
      sources: [],
    } as unknown as DpsView;
    const markup = renderToStaticMarkup(<DpsTable dps={dps} />);
    const heads = markup.match(/<th style="[^"]*"/g) ?? [];
    expect(heads.length).toBe(5);
    for (const h of heads.slice(1)) {
      expect(h).toContain("white-space:nowrap");
      expect(h).toContain("padding:4px 0 4px 10px");
    }
  });
});

describe("gallery: rift guardians (QA minor: the Choir of Cinders overflowed its cell)", () => {
  const loaded = loadMode(mode, modules);
  const sections = buildGallerySections(loaded.registry, []);
  const monsters = sections.find((s) => s.id === "monsters");
  const bosses = sections.find((s) => s.id === "bosses");

  it("puts bosses and guardians in their own two-row section", () => {
    expect(monsters).toBeDefined();
    expect(bosses).toBeDefined();
    expect(bosses!.rowsPerPage).toBe(2);
    for (const h of bosses!.rowHeaders ?? []) expect(h).toMatch(/ \((boss|rift guardian)/);
    for (const h of monsters!.rowHeaders ?? []) expect(h).not.toMatch(/ \((boss|rift guardian)/);
    expect((bosses!.rowHeaders ?? []).filter((h) => h.includes("(rift guardian)")).length).toBe(2);
  });

  it("gives big units extra head room over their scale", () => {
    const unit = (scale: number): GalleryCell => ({
      key: `u${scale}`,
      kind: "unit",
      title: "idle",
      ref: "unit.x",
      entity: { scale } as GalleryCell["entity"],
    });
    const normal = cellTopPx(unit(100));
    const big = cellTopPx(unit(150));
    // More than the plain 1.5x of the head height.
    expect(big - 26).toBeGreaterThan((normal - 26) * 1.5);
  });
});
