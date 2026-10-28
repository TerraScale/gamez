/**
 * Wave A scene visuals (docs/design/wave-A.md §10.1, §5.6): cast glow in the
 * skill's element, white hit flash, gem tint on the ground, set rarity label,
 * loot filter (no label, faded drop) and the rift stations labelled like stairs.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import { AreaTag, Casting, Interactable, Loot, Pos } from "../src/components.ts";
import { DEFAULT_LOOT_FILTER, RES, type LootFilter } from "../src/resources.ts";
import { tileCenter } from "../src/fixed.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "../src/types.ts";
import { ELEMENT_COLOR, GOLD_COLOR, RARITY_COLOR } from "../src/client/contract.ts";
import {
  CAST_GLOW,
  GEM_COLOR,
  HIDDEN_LOOT_ALPHA,
  lootTintOf,
  SceneSync,
  type SceneInput,
  type SceneRenderer,
  skillGlowColor,
  STATION_NAME,
} from "../src/client/scene.ts";
import { testSim, spawnTestHero, spawnTestMonster, useOpenMap } from "./support/harness.ts";

class FakeRenderer implements SceneRenderer {
  readonly live = new Map<string, ArpgRenderEntity>();
  upsertEntity(e: ArpgRenderEntity): void {
    this.live.set(e.id, { ...e });
  }
  removeEntity(id: string): void {
    this.live.delete(id);
  }
  setMap(): void {}
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
    lighting: false,
    tick: sim.tick,
    ...over,
  };
}

function setup(content: "test" | "real" = "test") {
  const sim = testSim([], { content });
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
  const renderer = new FakeRenderer();
  const scene = new SceneSync(renderer);
  return { sim, hero, renderer, scene };
}

function itemOf(base: string, rarity: ItemInstance["rarity"], name: string, uid = 1): ItemInstance {
  return { uid, base, rarity, ilvl: 1, name, mods: [], affixes: [], value: 1 };
}

describe("cast glow and hit flash", () => {
  it("glows a casting unit in its skill's element colour, and nothing else", () => {
    const { sim, scene, renderer } = setup("real");
    const m = spawnTestMonster(sim.world, { x: 8, y: 5 });
    sim.world.add(m, Casting, {
      skill: "classic.skill.ember_bolt",
      rank: 1,
      target: 0,
      x: 0,
      y: 0,
      startedAt: 0,
      hitAt: 5,
      endAt: 10,
      fired: false,
      pulses: 0,
    });
    scene.render(input(sim, { tick: 3 }));
    const ent = renderer.live.get(`c${m}`);
    expect(ent?.castGlow).toBe(CAST_GLOW);
    expect(ent?.glowColor).toBe(ELEMENT_COLOR.fire);
    const other = spawnTestMonster(sim.world, { x: 9, y: 5 });
    scene.render(input(sim, { tick: 3 }));
    expect(renderer.live.get(`c${other}`)?.castGlow).toBeUndefined();
  });

  it("uses the white glow for a weapon skill without an element", () => {
    const { sim } = setup("real");
    expect(skillGlowColor(sim.loaded.registry, "classic.skill.attack")).toBe(0xffffff);
    expect(skillGlowColor(sim.loaded.registry, "classic.skill.nope")).toBe(0xffffff);
  });

  it("flashes a hit in white (additive overlay), not red", () => {
    const { sim, scene, renderer } = setup();
    const m = spawnTestMonster(sim.world, { x: 8, y: 5 });
    sim.step(3);
    // The first render picks up the area and forgets earlier hits (as in the game loop).
    scene.render(input(sim));
    scene.noteHit(m, sim.tick - 1);
    scene.render(input(sim));
    const ent = renderer.live.get(`c${m}`);
    expect(ent?.hitFlash).toBeGreaterThan(0);
    expect(ent?.hitFlashColor).toBe(0xffffff);
  });
});

describe("loot visuals", () => {
  it("tints gems by kind and labels set items in the set colour", () => {
    const { sim, scene, renderer } = setup("real");
    const reg = sim.loaded.registry;
    const gem = [...reg.all<ItemBaseProto>(KIND.itemBase)].find(([, b]) => b.category === "gem");
    expect(gem).toBeDefined();
    const [gemBase, gemProto] = gem!;
    const gemLoot = sim.world.create();
    sim.world.add(gemLoot, Loot, {
      kind: "item",
      item: itemOf(gemBase, "magic", gemProto.name),
      gold: 0,
      potion: "",
      droppedAt: 0,
    });
    sim.world.add(gemLoot, Pos, { x: tileCenter(6), y: tileCenter(6) });
    sim.world.add(gemLoot, AreaTag, { depth: 1 });
    scene.render(input(sim));
    const g = renderer.live.get(`c${gemLoot}`);
    expect(g?.appearance).toBe("loot.item.gem");
    expect(g?.tint).toBe(gemProto.gem ? GEM_COLOR[gemProto.gem.kind] : 0xffffff);
    expect(lootTintOf(reg, gemBase)).toBe(g?.tint);

    const weapon = [...reg.all<ItemBaseProto>(KIND.itemBase)].find(
      ([, b]) => b.category === "weapon",
    );
    const setLoot = sim.world.create();
    sim.world.add(setLoot, Loot, {
      kind: "item",
      item: itemOf(weapon![0], "set", "Ember Blade"),
      gold: 0,
      potion: "",
      droppedAt: 0,
    });
    sim.world.add(setLoot, Pos, { x: tileCenter(7), y: tileCenter(6) });
    sim.world.add(setLoot, AreaTag, { depth: 1 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${setLoot}`)?.labelColor).toBe(RARITY_COLOR.set);
    expect(renderer.live.get(`c${setLoot}`)?.showLabel).toBe(true);
  });

  it("hides labels of loot the filter hides, and fades the drop", () => {
    const { sim, scene, renderer } = setup();
    sim.world.setResource<LootFilter>(RES.lootFilter, { ...DEFAULT_LOOT_FILTER, showGold: false });
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 25, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(4), y: tileCenter(4) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    scene.render(input(sim));
    const g = renderer.live.get(`c${gold}`);
    expect(g).toMatchObject({ kind: "loot", showLabel: false, alpha: HIDDEN_LOOT_ALPHA });
    expect(g?.labelColor).toBe(GOLD_COLOR);
  });

  it("keeps the label of visible gold and no fade under the default filter", () => {
    const { sim, scene, renderer } = setup();
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 25, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(4), y: tileCenter(4) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    scene.render(input(sim));
    const g = renderer.live.get(`c${gold}`);
    expect(g?.showLabel).toBe(true);
    expect(g?.alpha).toBeUndefined();
  });
});

describe("rift stations", () => {
  it("labels the obelisk and the rift exit like stairs, even far away", () => {
    const { sim, scene, renderer } = setup();
    for (const kind of ["riftObelisk", "riftExit"] as const) {
      const e = sim.world.create();
      sim.world.add(e, Interactable, { kind, toDepth: 0 });
      sim.world.add(e, Pos, { x: tileCenter(20), y: tileCenter(20) });
      sim.world.add(e, AreaTag, { depth: 1 });
      scene.render(input(sim));
      expect(renderer.live.get(`c${e}`), kind).toMatchObject({
        name: STATION_NAME[kind],
        showLabel: true,
      });
    }
  });
});
