/**
 * fight(): resolves one arena match. OWNER: T-arena-sim. The server (ArenaDO)
 * and the client replay call the very same function, so a replay with the
 * same seed and builds reproduces the server's hash (AGENTS.md §6).
 */
import { createSim, loadMode, type GameEvent, type LoadedMode, type World } from "@gamez/kernel";
import type { ArenaBuild, ArenaWinner } from "@gamez/protocol";
import { ARENA_MAX_TICKS } from "./constants.ts";
import { Fighter } from "./core.ts";
import { mode, modules } from "./mode.ts";
import { MATCH_RESOURCE, RESULT_RESOURCE, type ArenaResult, type MatchRefs } from "./model.ts";

/** One replay frame (every tick or every change; the owner decides the density). */
export interface ArenaFrame {
  tick: number;
  /** Fighter positions in tenths of a tile on a 1-D lane (0..200) and hp. */
  attacker: { x: number; hp: number; shield: number; action: string | null };
  defender: { x: number; hp: number; shield: number; action: string | null };
  /** Floating texts: damage, heals, crits, skill names. */
  texts: { side: "attacker" | "defender"; text: string; kind: "dmg" | "crit" | "heal" | "skill" }[];
}

export interface ArenaFightResult {
  winner: ArenaWinner;
  ticks: number;
  /** sim.hash() at the end. */
  hash: string;
  /** contentHash of the arena mode. */
  contentHash: string;
  /** Only when opts.frames: the replay timeline. */
  frames: ArenaFrame[] | null;
}

let cached: LoadedMode | null = null;

/** The loaded arena mode (memoised). */
export function arenaLoaded(): LoadedMode {
  cached ??= loadMode(mode, modules);
  return cached;
}

function sideOf(ev: GameEvent): "attacker" | "defender" {
  return ev.side === "defender" ? "defender" : "attacker";
}

/** Frame of the tick that just ran: positions, hp, shields, actions and floating texts from its events. */
function frameOf(world: World, refs: MatchRefs, events: GameEvent[], tick: number): ArenaFrame {
  const a = world.read(refs.attacker, Fighter);
  const d = world.read(refs.defender, Fighter);
  const action: Record<"attacker" | "defender", string | null> = {
    attacker: null,
    defender: null,
  };
  const texts: ArenaFrame["texts"] = [];
  for (const ev of events) {
    const side = sideOf(ev);
    if (ev.type === "arena.act") {
      const name = typeof ev.name === "string" ? ev.name : null;
      action[side] = name;
      if (ev.skill === true && name) texts.push({ side, text: name, kind: "skill" });
    } else if (ev.type === "arena.hit") {
      const amount = Number(ev.amount);
      texts.push({ side, text: String(amount), kind: ev.crit === true ? "crit" : "dmg" });
    } else if (ev.type === "arena.heal") {
      const amount = Number(ev.amount);
      if (amount > 0) texts.push({ side, text: `+${amount}`, kind: "heal" });
    }
  }
  return {
    tick,
    attacker: { x: a.x, hp: a.hp, shield: a.shield, action: action.attacker },
    defender: { x: d.x, hp: d.hp, shield: d.shield, action: action.defender },
    texts,
  };
}

/**
 * Runs attacker vs defender with `seed` (uint32) until a fighter drops or
 * ARENA_MAX_TICKS. Pure and deterministic. Never throws for valid builds
 * (the arena.start action clamps anything out of range).
 */
export function fight(
  attacker: ArenaBuild,
  defender: ArenaBuild,
  seed: number,
  opts: { frames?: boolean } = {},
): ArenaFightResult {
  const loaded = arenaLoaded();
  const sim = createSim(loaded, { seed });
  const frames: ArenaFrame[] | null = opts.frames ? [] : null;
  const start = sim.dispatch("arena.start", { attacker, defender }, null);
  if (start.ok) {
    const refs = sim.world.getResource<MatchRefs>(MATCH_RESOURCE);
    if (!refs) throw new Error("arena.start did not place the fighters");
    while (!sim.world.getResource<ArenaResult>(RESULT_RESOURCE) && sim.tick < ARENA_MAX_TICKS) {
      const events = sim.step(1);
      if (frames) frames.push(frameOf(sim.world, refs, events, sim.tick - 1));
    }
  }
  const result = start.ok ? sim.world.getResource<ArenaResult>(RESULT_RESOURCE) : undefined;
  return {
    winner: result?.winner ?? "draw",
    ticks: result?.ticks ?? 0,
    hash: sim.hash(),
    contentHash: loaded.contentHash,
    frames,
  };
}
