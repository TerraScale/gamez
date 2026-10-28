/** "Outline my hero": the setting, its panel toggle, the scene's highlight and the gallery pages. */
import { describe, expect, it } from "vite-plus/test";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { loadMode } from "@gamez/kernel";
import { mode, modules } from "../src/index.ts";
import { KIND, type ClassProto } from "../src/types.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/client/persist.ts";
import { DISPLAY_FLAGS, settingsHandlers } from "../src/client/hud/panels/SettingsPanel.tsx";
import { SceneSync, type SceneInput, type SceneRenderer } from "../src/client/scene.ts";
import { buildGallerySections, GALLERY_ACTIONS, GALLERY_OUTLINES } from "../src/client/gallery.ts";
import type { ClassicClientApi, Settings } from "../src/client/contract.ts";
import { testSim, spawnTestHero, spawnTestMonster, useOpenMap } from "./support/harness.ts";

describe("outlineHero setting", () => {
  it("is on by default and survives sanitising", () => {
    expect(DEFAULT_SETTINGS.outlineHero).toBe(true);
    expect(sanitizeSettings({}).outlineHero).toBe(true);
    expect(sanitizeSettings(null).outlineHero).toBe(true);
    expect(sanitizeSettings({ outlineHero: false }).outlineHero).toBe(false);
    expect(sanitizeSettings({ outlineHero: "no" }).outlineHero).toBe(true);
    expect(sanitizeSettings({ outlineHero: 0 }).outlineHero).toBe(true);
  });

  it("is the first Display toggle and its handler sends the flag", () => {
    expect(DISPLAY_FLAGS[0]).toEqual({ key: "outlineHero", label: "Outline my hero" });
    const sent: Partial<Settings>[] = [];
    const api = {
      updateSettings: (p: Partial<Settings>) => sent.push(p),
    } as unknown as ClassicClientApi;
    settingsHandlers(api).flag("outlineHero", false);
    expect(sent).toEqual([{ outlineHero: false }]);
  });
});

class FakeRenderer implements SceneRenderer {
  readonly live = new Map<string, ArpgRenderEntity>();
  upsertEntity(e: ArpgRenderEntity): void {
    this.live.set(e.id, { ...e });
  }
  removeEntity(id: string): void {
    this.live.delete(id);
  }
  setMap(_map: TileMap): void {}
  snapCamera(): void {}
  setLighting(): void {}
  follow(): void {}
}

function input(sim: ReturnType<typeof testSim>, over: Partial<SceneInput> = {}): SceneInput {
  return {
    world: sim.world,
    registry: sim.loaded.registry,
    alpha: 1,
    hovered: 0,
    targeted: 0,
    showLootLabels: true,
    lighting: true,
    tick: sim.tick,
    ...over,
  };
}

describe("scene: the played hero's outline", () => {
  it("marks the hero 'self' (default and on) and nothing when the setting is off", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
    const renderer = new FakeRenderer();
    const scene = new SceneSync(renderer);
    scene.render(input(sim));
    expect(renderer.live.get(`c${hero}`)?.highlight).toBe("self");
    expect(renderer.live.get(`c${monster}`)?.highlight).toBe(false);
    scene.render(input(sim, { outlineHero: false }));
    expect(renderer.live.get(`c${hero}`)?.highlight).toBeNull();
    scene.render(input(sim, { outlineHero: true }));
    expect(renderer.live.get(`c${hero}`)?.highlight).toBe("self");
    // Hovering a monster still uses the boolean hover channel.
    scene.render(input(sim, { hovered: monster }));
    expect(renderer.live.get(`c${monster}`)?.highlight).toBe(true);
  });
});

describe("gallery: outline pages", () => {
  const reg = loadMode(mode, modules).registry;
  const sections = buildGallerySections(reg, []);

  it("shows self, party and ally in every action on a town and a dungeon floor", () => {
    const town = sections.find((s) => s.id === "outlines");
    const dungeon = sections.find((s) => s.id === "outlines-dungeon");
    expect(town?.ground).toBe("tile.grass");
    expect(dungeon?.ground).toBe("tile.crypt.floor");
    const firstClass = reg.all<ClassProto>(KIND.class)[0]!;
    for (const s of [town!, dungeon!]) {
      expect(s.cells).toHaveLength(GALLERY_OUTLINES.length * GALLERY_ACTIONS.length);
      expect(s.rowHeaders).toHaveLength(GALLERY_OUTLINES.length);
      for (const kind of GALLERY_OUTLINES) {
        const row = s.cells.filter((c) => c.entity?.highlight === kind);
        expect(row.map((c) => c.action)).toEqual([...GALLERY_ACTIONS]);
        for (const c of row) expect(c.entity?.appearance).toBe(firstClass[1].appearance);
      }
    }
    expect(GALLERY_OUTLINES).toEqual(["self", "party", "ally"]);
  });
});
