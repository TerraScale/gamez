import { describe, expect, it } from "vite-plus/test";
import { createSim, loadMode, stableHash, type GameEvent, type Registry } from "@gamez/kernel";
import { effectiveness, maxHpAt, statAt, xpToNext, damageFor } from "../src/combat.ts";
import { mode, modules } from "../src/index.ts";
import { BATTLE, Mon, STARTER_LEVEL, type BattleState, type CreatureDef } from "../src/schema.ts";
import {
  battleOf,
  captureUntilEnded,
  monOf,
  newSim,
  nextCommand,
  playUntil,
  teamMons,
} from "./helpers.ts";

/** Pinned result of the scripted battle below (seed 7). Update only when the rules change on purpose. */
const PINNED_HASH = "3f241bc0c6440e1b";
const PINNED_EVENTS_HASH = "c5720826aa434993";
const PINNED_EVENT_COUNT = 79;

const eventsOf = (results: { events: GameEvent[] }[]) => results.flatMap((r) => r.events);

describe("duel data", () => {
  it("defines four elements, eleven moves and eight creatures", () => {
    const reg = newSim(1).loaded.registry;
    expect(reg.all("duel.element")).toHaveLength(4);
    expect(reg.all("duel.move")).toHaveLength(11);
    expect(reg.all("duel.creature")).toHaveLength(8);
  });

  it("gives every creature four distinct, existing moves", () => {
    const reg = newSim(1).loaded.registry;
    for (const [, c] of reg.all<CreatureDef>("duel.creature")) {
      expect(new Set(c.moves).size).toBe(4);
      for (const m of c.moves) expect(reg.has("duel.move", m)).toBe(true);
    }
  });

  it("applies the element chart in both directions", () => {
    const reg = newSim(1).loaded.registry;
    expect(effectiveness(reg, "ember", "sprout")).toBe(150);
    expect(effectiveness(reg, "sprout", "ember")).toBe(50);
    expect(effectiveness(reg, "volt", "ember")).toBe(50);
    expect(effectiveness(reg, "ember", "volt")).toBe(100);
  });

  it("fails the load when a creature points at a missing move", () => {
    const creatures = modules.find((m) => m.id === "duel.creatures")!;
    const broken = {
      ...creatures,
      data(reg: Registry) {
        creatures.data!(reg);
        reg.patch<CreatureDef>("duel.creature", "cindrel", (c) => {
          c.moves = ["ember-lash", "no-such-move", "flare-dash", "static-nip"];
        });
      },
    };
    expect(() =>
      loadMode(mode, [broken, ...modules.filter((m) => m.id !== "duel.creatures")]),
    ).toThrow(/unknown move no-such-move/);
  });

  it("keeps damage and stats in whole numbers", () => {
    expect(Number.isInteger(statAt(45, 7))).toBe(true);
    expect(damageFor(5, 40, 50, 50, 100, 90)).toBeGreaterThanOrEqual(1);
    expect(xpToNext(5)).toBe(50);
  });
});

describe("setup", () => {
  it("starts with three level-5 starters and a wild battle in the choose phase", () => {
    const sim = newSim(7);
    const team = teamMons(sim);
    expect(team.map((t) => t.mon.slot)).toEqual([0, 1, 2]);
    expect(team.every((t) => t.mon.level === STARTER_LEVEL && t.mon.hp === t.mon.maxHp)).toBe(true);
    const b = battleOf(sim);
    expect(b.phase).toBe("choose");
    expect(b.battles).toBe(1);
    expect(b.wildMon).not.toBeNull();
    expect(monOf(sim, b.wildMon).owner).toBe("wild");
  });

  it("picks the same starters for the same seed", () => {
    const species = (seed: number) => teamMons(newSim(seed)).map((t) => t.mon.species);
    expect(species(11)).toEqual(species(11));
  });

  it("uses the registry maxHp for new creatures", () => {
    const sim = newSim(3);
    const reg = sim.loaded.registry;
    for (const t of teamMons(sim)) {
      const species = reg.require<CreatureDef>("duel.creature", t.mon.species);
      expect(t.mon.maxHp).toBe(maxHpAt(species, STARTER_LEVEL));
    }
  });
});

describe("determinism", () => {
  it("same seed and same commands give the same hash and events", () => {
    const a = newSim(42);
    const b = newSim(42);
    const ra = playUntil(a, () => false, 25);
    const rb = playUntil(b, () => false, 25);
    expect(rb).toEqual(ra);
    expect(b.hash()).toBe(a.hash());
  });

  it("different seeds diverge", () => {
    const a = newSim(1);
    const b = newSim(2);
    playUntil(a, () => false, 10);
    playUntil(b, () => false, 10);
    expect(b.hash()).not.toBe(a.hash());
  });

  it("restoring a snapshot continues like an uninterrupted sim", () => {
    const loaded = loadMode(mode, modules);
    const whole = createSim(loaded, { seed: 9 });
    const head = createSim(loaded, { seed: 9 });
    playUntil(whole, () => false, 4);
    playUntil(head, () => false, 4);
    // Persist the head through JSON, resume it and play the same remaining commands.
    const restored = createSim(loaded, {
      seed: 9,
      from: JSON.parse(JSON.stringify(head.snapshot())),
    });
    playUntil(whole, () => false, 6);
    playUntil(restored, () => false, 6);
    expect(restored.hash()).toBe(whole.hash());
  });
});

describe("scripted battle", () => {
  it("plays the pinned sequence for seed 7", () => {
    const sim = newSim(7);
    const results = playUntil(sim, (s) => s.tick >= 14, 14);
    expect(results.every((r) => r.ok)).toBe(true);
    const types = eventsOf(results).map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "duel.turn",
      "duel.moveUsed",
      "duel.effectiveness",
      "duel.damage",
    ]);
    expect(types.length).toBe(PINNED_EVENT_COUNT);
    expect(stableHash(eventsOf(results))).toBe(PINNED_EVENTS_HASH);
    expect(sim.hash()).toBe(PINNED_HASH);
  });
});

describe("invalid actions", () => {
  it("rejects useMove outside a battle", () => {
    const sim = newSim(5);
    playUntil(sim, (s) => battleOf(s).phase === "ended", 200);
    expect(battleOf(sim).phase).toBe("ended");
    const res = sim.dispatch("duel.useMove", { moveId: "ember-lash" }, "p");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("no_battle");
  });

  it("rejects a move the active creature does not know", () => {
    const sim = newSim(7);
    const lead = monOf(sim, battleOf(sim).playerMon);
    const known = sim.loaded.registry.require<CreatureDef>("duel.creature", lead.species).moves;
    const unknown = ["ember-lash", "cinder-burst", "leaf-whip", "tidal-jab", "bolt-drive"].find(
      (m) => !known.includes(m),
    )!;
    const before = sim.hash();
    const res = sim.dispatch("duel.useMove", { moveId: unknown }, "p");
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_move" } });
    expect(sim.hash()).toBe(before);
  });

  it("rejects malformed payloads", () => {
    const sim = newSim(7);
    expect(sim.dispatch("duel.useMove", {}, "p").error?.code).toBe("bad_payload");
    expect(sim.dispatch("duel.useMove", { moveId: 3 }, "p").error?.code).toBe("bad_payload");
    expect(sim.dispatch("duel.switch", { slot: 9 }, "p").error?.code).toBe("bad_payload");
  });

  it("rejects switching to the active creature and to an empty slot", () => {
    const sim = newSim(7);
    const b = battleOf(sim);
    const activeSlot = monOf(sim, b.playerMon).slot;
    expect(sim.dispatch("duel.switch", { slot: activeSlot }, "p").error?.code).toBe(
      "already_active",
    );
    expect(sim.dispatch("duel.switch", { slot: 5 }, "p").error?.code).toBe("bad_target");
  });

  it("rejects heal and next battle during a battle", () => {
    const sim = newSim(7);
    expect(sim.dispatch("duel.heal", null, "p").error?.code).toBe("battle_active");
    expect(sim.dispatch("duel.nextBattle", null, "p").error?.code).toBe("battle_active");
  });

  it("rejects everything but switch while a replacement is due", () => {
    const sim = newSim(7);
    sim.world.update(battleOf(sim).playerMon!, Mon, { hp: 1 });
    playUntil(sim, (s) => battleOf(s).phase === "switch", 60);
    expect(battleOf(sim).phase).toBe("switch");
    expect(sim.dispatch("duel.useMove", { moveId: "ember-lash" }, "p").error?.code).toBe(
      "must_switch",
    );
    expect(sim.dispatch("duel.capture", null, "p").error?.code).toBe("must_switch");
  });
});

describe("faint and switch", () => {
  it("asks for a switch when the lead faints and resumes after the switch", () => {
    const sim = newSim(7);
    const lead = battleOf(sim).playerMon;
    sim.world.update(lead!, Mon, { hp: 1 });
    const results = playUntil(sim, (s) => battleOf(s).phase === "switch", 60);
    expect(battleOf(sim).phase).toBe("switch");
    expect(eventsOf(results).map((e) => e.type)).toContain("duel.fainted");
    expect(eventsOf(results).map((e) => e.type)).toContain("duel.switchRequired");

    const [name, payload] = nextCommand(sim);
    expect(name).toBe("duel.switch");
    const res = sim.dispatch(name, payload, "p");
    expect(res.ok).toBe(true);
    expect(battleOf(sim).phase).toBe("choose");
    expect(battleOf(sim).playerMon).not.toBe(lead);
  });
});

describe("team wipe", () => {
  it("ends the battle as lost when the last creature faints, and heal allows the next battle", () => {
    const sim = newSim(7);
    for (const t of teamMons(sim)) {
      sim.world.update(t.entity, Mon, { hp: t.entity === battleOf(sim).playerMon ? 1 : 0 });
    }
    const results = playUntil(sim, (s) => battleOf(s).phase === "ended", 80);
    expect(battleOf(sim).result).toBe("lost");
    expect(eventsOf(results).map((e) => e.type)).toContain("duel.battleEnded");
    expect(teamMons(sim).every((t) => t.mon.hp === 0)).toBe(true);

    expect(sim.dispatch("duel.nextBattle", null, "p").error?.code).toBe("no_fit_creature");
    expect(sim.dispatch("duel.heal", null, "p").ok).toBe(true);
    expect(teamMons(sim).every((t) => t.mon.hp === t.mon.maxHp)).toBe(true);
    expect(sim.dispatch("duel.nextBattle", null, "p").ok).toBe(true);
    expect(battleOf(sim).battles).toBe(2);
    expect(battleOf(sim).phase).toBe("choose");
  });
});

describe("win and XP", () => {
  it("wins a battle against a wounded wild creature and gives the lead XP", () => {
    const sim = newSim(7);
    const wild = battleOf(sim).wildMon!;
    sim.world.update(wild, Mon, { hp: 1 });
    const results = playUntil(sim, (s) => battleOf(s).phase === "ended", 40);
    expect(battleOf(sim).result).toBe("won");
    const types = eventsOf(results).map((e) => e.type);
    expect(types).toContain("duel.fainted");
    expect(types).toContain("duel.xpGained");
  });
});

describe("capture", () => {
  it("adds a caught creature to the team", () => {
    const sim = newSim(7);
    sim.world.update(battleOf(sim).wildMon!, Mon, { hp: 1 });
    const before = teamMons(sim).length;
    const results = captureUntilEnded(sim);
    expect(battleOf(sim).result).toBe("captured");
    expect(teamMons(sim)).toHaveLength(before + 1);
    const caught = teamMons(sim).at(-1)!;
    expect(caught.mon.owner).toBe("player");
    expect(caught.mon.team).toBe(true);
    expect(eventsOf(results).map((e) => e.type)).toContain("duel.captured");
  });

  it("sends a catch to the box when the team is full", () => {
    const sim = newSim(7);
    const reg = sim.loaded.registry;
    // Fill the team to six by hand (test-only world edit), then catch a creature.
    const template = monOf(sim, battleOf(sim).playerMon);
    for (let slot = 3; slot < 6; slot++) {
      const e = sim.world.create();
      sim.world.add(e, Mon, { ...template, owner: "player", team: true, slot });
    }
    expect(teamMons(sim)).toHaveLength(6);
    expect(reg.all("duel.creature").length).toBeGreaterThan(0);
    sim.world.update(battleOf(sim).wildMon!, Mon, { hp: 1 });
    captureUntilEnded(sim);
    expect(battleOf(sim).result).toBe("captured");
    expect(teamMons(sim)).toHaveLength(6);
    const boxed = sim.world.query(Mon).filter((e) => {
      const m = sim.world.read(e, Mon);
      return m.owner === "player" && !m.team;
    });
    expect(boxed).toHaveLength(1);
  });
});

describe("battle state", () => {
  it("keeps the battle resource typed and present after a battle", () => {
    const sim = newSim(7);
    playUntil(sim, (s) => battleOf(s).phase === "ended" || s.tick > 60, 60);
    const b = sim.world.getResource<BattleState>(BATTLE);
    expect(b).toBeDefined();
  });
});
