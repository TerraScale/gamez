import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GameEvent } from "@gamez/kernel";
import { buildBattleView, describeEvent } from "../src/client/model.ts";
import { duelView } from "../src/client/index.ts";
import { DuelScreen, type DuelScreenProps } from "../src/client/screen.tsx";
import { battleOf, newSim, playUntil } from "./helpers.ts";
import { Mon } from "../src/schema.ts";

function props(over: Partial<DuelScreenProps>): DuelScreenProps {
  return {
    view: null,
    status: "online",
    error: null,
    log: [],
    busy: false,
    switchOpen: false,
    onMove: () => {},
    onSwitch: () => {},
    onCapture: () => {},
    onFlee: () => {},
    onNext: () => {},
    onHeal: () => {},
    onToggleSwitch: () => {},
    ...over,
  };
}

describe("buildBattleView", () => {
  it("describes the opening battle from the world", () => {
    const sim = newSim(7);
    const view = buildBattleView(sim.world, sim.loaded.registry)!;
    expect(view.phase).toBe("choose");
    expect(view.team).toHaveLength(3);
    expect(view.lead?.moves).toHaveLength(4);
    expect(view.wild).not.toBeNull();
    expect(view.canMove).toBe(true);
    expect(view.canCapture).toBe(true);
    expect(view.canHeal).toBe(false);
    expect(view.canNext).toBe(false);
    expect(view.status).toContain("choose a move");
  });

  it("offers next battle and heal between battles", () => {
    const sim = newSim(7);
    // Flee until the battle ends (a flee succeeds half the time, deterministically per seed).
    for (let i = 0; i < 80 && battleOf(sim).phase !== "ended"; i++) {
      sim.dispatch("duel.flee", null, "p1");
    }
    const view = buildBattleView(sim.world, sim.loaded.registry)!;
    expect(view.phase).toBe("ended");
    expect(view.canHeal).toBe(true);
    expect(view.canNext).toBe(true);
    expect(view.canMove).toBe(false);
    expect(view.canCapture).toBe(false);
  });

  it("marks switch-only phases correctly", () => {
    const sim = newSim(7);
    sim.world.update(battleOf(sim).playerMon!, Mon, { hp: 1 });
    playUntil(sim, (s) => battleOf(s).phase === "switch", 60);
    const view = buildBattleView(sim.world, sim.loaded.registry)!;
    expect(view.canMove).toBe(false);
    expect(view.canCapture).toBe(false);
    expect(view.canSwitch).toBe(true);
    expect(view.status).toContain("fainted");
  });
});

describe("describeEvent", () => {
  it("turns damage and faints into log lines", () => {
    const damage: GameEvent = {
      type: "duel.damage",
      side: "wild",
      target: 4,
      name: "Scorchug",
      amount: 12,
      hp: 30,
      maxHp: 50,
    };
    expect(describeEvent(damage)).toBe("Scorchug took 12 damage (30/50 HP).");
    expect(describeEvent({ type: "duel.fainted", side: "player", mon: 1, name: "Mossbud" })).toBe(
      "Mossbud fainted!",
    );
  });

  it("marks the wild side and effectiveness", () => {
    expect(
      describeEvent({
        type: "duel.moveUsed",
        side: "wild",
        mon: 4,
        name: "Scorchug",
        moveId: "x",
        move: "Cinder Burst",
      }),
    ).toBe("Wild Scorchug used Cinder Burst!");
    expect(describeEvent({ type: "duel.effectiveness", multiplier: 150 })).toBe(
      "It's super effective!",
    );
    expect(describeEvent({ type: "duel.effectiveness", multiplier: 50 })).toBe(
      "It's not very effective.",
    );
  });

  it("returns null for events without a line", () => {
    expect(describeEvent({ type: "duel.unknownThing" })).toBeNull();
  });
});

describe("DuelScreen", () => {
  it("shows a connecting message before the first state arrives", () => {
    const html = renderToStaticMarkup(<DuelScreen {...props({ status: "connecting" })} />);
    expect(html).toContain("Connecting to your battle");
  });

  it("renders the battle with four move buttons and team controls", () => {
    const sim = newSim(7);
    const view = buildBattleView(sim.world, sim.loaded.registry)!;
    const html = renderToStaticMarkup(
      <DuelScreen
        {...props({
          view,
          log: [{ id: 1, text: "A wild thing appeared!" }],
        })}
      />,
    );
    expect(html.match(/class="duel-move /g)).toHaveLength(4);
    expect(html).toContain(view.lead!.name);
    expect(html).toContain(view.wild!.name);
    expect(html).toContain("A wild thing appeared!");
    expect(html).toContain('role="log"');
  });

  it("shows the error message from a rejected action", () => {
    const html = renderToStaticMarkup(
      <DuelScreen {...props({ error: { code: "no_pp", message: "Ember Lash has no PP left" } })} />,
    );
    expect(html).toContain("Ember Lash has no PP left");
  });
});

describe("duelView", () => {
  it("is the duel mode's client view", () => {
    expect(duelView.modeId).toBe("duel");
  });
});
