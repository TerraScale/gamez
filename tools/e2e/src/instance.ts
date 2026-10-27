/**
 * Instance checks for the phase-1 test modes over /ws/instance. The e2e loads
 * the same catalog as the game, so it can replay every action on a local sim
 * restored from the server's snapshot and demand the identical result: same
 * ok/error code, same events and the same snapshot hash.
 *
 *  play():   join a new instance, run a scripted action sequence, and in the
 *            middle reject an invalid action, an unknown action and a stale seq;
 *  resume(): after the dev server restarted, a plain join must return the
 *            persisted snapshot (same hash, same lastSeq) and accept the next
 *            action; a fresh join must reset the instance, and stay reset.
 */
import { createSim, loadMode, stableHash, type LoadedMode, type Sim } from "@gamez/kernel";
import { BATTLE, Mon, type BattleState, type CreatureDef, type MonState } from "@gamez/mode-duel";
import { Actor, chebyshev, floorOf, heroEntity, Position, runOf } from "@gamez/mode-steps";
import { findPath } from "@gamez/world";
// The catalog the Worker and the browser load, so contentHash must match the server's.
import { MODES, MODULE_CATALOG } from "../../../apps/game/src/shared/catalog.ts";
import type { Guest } from "./client.ts";
import { InstanceBot, type ResultMsg } from "./instance-client.ts";
import { check, timings } from "./report.ts";

type Command = [name: string, payload: unknown];

export interface ModeScript {
  mode: string;
  /** Scripted actions sent before the restart. */
  actions: number;
  /** The next action a simple player would send, or null to stop early. */
  next(sim: Sim): Command | null;
  /** An action the sim must reject (the expected code comes from the local replay). */
  invalid(sim: Sim): Command;
  /** Event types that must appear in the scripted results. */
  expectEvents: string[];
}

/** Walks to the stairs (bumping into adjacent monsters), then descends. */
const steps: ModeScript = {
  mode: "steps",
  actions: 24,
  next(sim) {
    const world = sim.world;
    if (runOf(world).over) return null;
    const floor = floorOf(world);
    const hero = world.read(heroEntity(world), Position);
    if (hero.x === floor.stairs.x && hero.y === floor.stairs.y) return ["steps.descend", {}];
    const foe = world
      .query(Actor, Position)
      .filter((e) => world.read(e, Actor).kind === "steps.monster")
      .map((e) => world.read(e, Position))
      .find((p) => chebyshev(p, hero) === 1);
    const to = foe ?? findPath(floor, hero, floor.stairs)?.[0];
    return to ? ["steps.move", { dx: to.x - hero.x, dy: to.y - hero.y }] : ["steps.wait", {}];
  },
  invalid: () => ["steps.move", { dx: 2, dy: 0 }],
  expectEvents: ["steps.moved"],
};

function battleOf(sim: Sim): BattleState {
  const b = sim.world.getResource<BattleState>(BATTLE);
  if (!b) throw new Error("duel: no battle state");
  return b;
}

/** Switches when forced, starts the next battle when one ended, else uses the first move with PP. */
const duel: ModeScript = {
  mode: "duel",
  actions: 16,
  next(sim) {
    const b = battleOf(sim);
    if (b.phase === "ended") return ["duel.nextBattle", null];
    const mons = sim.world.query(Mon).map((e) => ({ e, mon: sim.world.read<MonState>(e, Mon) }));
    if (b.phase === "switch") {
      const next = mons.find(
        (m) => m.mon.owner === "player" && m.mon.team && m.mon.hp > 0 && m.e !== b.playerMon,
      );
      return next ? ["duel.switch", { slot: next.mon.slot }] : null;
    }
    if (b.playerMon === null) return null;
    const lead = sim.world.read<MonState>(b.playerMon, Mon);
    const species = sim.loaded.registry.require<CreatureDef>("duel.creature", lead.species);
    const idx = lead.pp.findIndex((pp) => pp > 0);
    return idx < 0 ? ["duel.capture", null] : ["duel.useMove", { moveId: species.moves[idx] }];
  },
  invalid: () => ["duel.useMove", { moveId: "no-such-move" }],
  expectEvents: ["duel.moveUsed"],
};

export const SCRIPTS: readonly ModeScript[] = [steps, duel];

/** Stays under the InstanceDO action limit (burst 10, 10/s). */
const ACTION_GAP_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loadedModes = new Map<string, LoadedMode>();

function loadedFor(mode: string): LoadedMode {
  let hit = loadedModes.get(mode);
  if (!hit) {
    const spec = MODES.find((m) => m.id === mode);
    if (!spec) throw new Error(`mode "${mode}" is not in the catalog`);
    hit = loadMode(spec, MODULE_CATALOG);
    loadedModes.set(mode, hit);
  }
  return hit;
}

/** A local sim restored from a server snapshot (the seed lives in the snapshot's rng state). */
function mirrorOf(mode: string, snapshot: ResultMsg["snapshot"]): Sim {
  return createSim(loadedFor(mode), { seed: 0, from: snapshot });
}

/** What play() leaves behind for resume(). */
export interface PlayedInstance {
  script: ModeScript;
  guest: Guest;
  /** Local sim equal to the server's state at the end. */
  mirror: Sim;
  hash: string;
  /** Seq of the last action the server applied (and persisted). */
  lastSeq: number;
  /** Next seq to send. */
  seq: number;
}

/**
 * Sends `cmd` with `seq`, replays it on `mirror` and checks the server agrees.
 * Returns an error string, or null when the server matched the local replay.
 */
async function actAndCompare(
  bot: InstanceBot,
  mirror: Sim,
  seq: number,
  [name, payload]: Command,
): Promise<{ res: ResultMsg; mismatch: string | null }> {
  const before = mirror.hash();
  const local = mirror.dispatch(name, payload, bot.guest.accountId);
  const res = await bot.act(seq, name, payload);
  const serverHash = stableHash(res.snapshot);
  let mismatch: string | null = null;
  if (res.ok !== local.ok || res.error?.code !== local.error?.code) {
    mismatch = `${name}: server ok=${res.ok} ${res.error?.code ?? ""}, local ok=${local.ok} ${local.error?.code ?? ""}`;
  } else if (serverHash !== mirror.hash()) {
    mismatch = `${name}: server hash ${serverHash}, local ${mirror.hash()} (before ${before})`;
  } else if (stableHash(res.events) !== stableHash(local.events)) {
    mismatch = `${name}: events differ from the local replay`;
  }
  return { res, mismatch };
}

export async function play(
  baseUrl: string,
  guest: Guest,
  script: ModeScript,
): Promise<PlayedInstance> {
  const { mode } = script;
  const loaded = loadedFor(mode);
  const bot = new InstanceBot(baseUrl, guest, mode);
  const state = await bot.join();
  timings[`${mode}: connect -> state (new instance)`] = performance.now() - bot.openedAt;
  check(
    state.mode === mode && state.contentHash === loaded.contentHash,
    `${mode}: join returns state with the local contentHash ${loaded.contentHash} (got ${state.contentHash})`,
  );
  check(
    state.lastSeq === 0 && state.snapshot.tick === 0,
    `${mode}: new instance starts at lastSeq 0, tick 0`,
  );
  let mirror = mirrorOf(mode, state.snapshot);
  check(mirror.hash() === stableHash(state.snapshot), `${mode}: local sim restores the snapshot`);

  let seq = 0;
  let lastSeq = 0;
  let sent = 0;
  const mismatches: string[] = [];
  const events = new Set<string>();
  const rtt: number[] = [];
  for (let i = 0; i < script.actions; i++) {
    if (i === 2) {
      // Rejections in the middle of the run: nothing may change.
      const hash = mirror.hash();
      const invalid = await actAndCompare(bot, mirror, ++seq, script.invalid(mirror));
      check(
        !invalid.res.ok && invalid.mismatch === null && stableHash(invalid.res.snapshot) === hash,
        `${mode}: invalid ${script.invalid(mirror)[0]} rejected with "${invalid.res.error?.code}" like the local sim, state unchanged`,
      );
      await sleep(ACTION_GAP_MS);
      const unknown = await bot.act(++seq, `${mode}.noSuchAction`, {});
      check(
        !unknown.ok &&
          unknown.error?.code === "unknown_action" &&
          stableHash(unknown.snapshot) === hash,
        `${mode}: unknown action rejected with "${unknown.error?.code}", state unchanged`,
      );
      await sleep(ACTION_GAP_MS);
      const stale = await bot.act(1, "noop", {});
      check(
        !stale.ok && stale.error?.code === "stale_seq" && stableHash(stale.snapshot) === hash,
        `${mode}: replayed seq 1 rejected with "${stale.error?.code}", state unchanged`,
      );
      await sleep(ACTION_GAP_MS);
    }
    const cmd = script.next(mirror);
    if (!cmd) break;
    const sentAt = performance.now();
    const { res, mismatch } = await actAndCompare(bot, mirror, ++seq, cmd);
    rtt.push(performance.now() - sentAt);
    sent++;
    if (mismatch) mismatches.push(`seq ${seq} ${mismatch}`);
    if (!res.ok) mismatches.push(`seq ${seq} ${cmd[0]} rejected: ${res.error?.code}`);
    else lastSeq = seq;
    for (const e of res.events) events.add(e.type);
    // Keep following the server even after a mismatch, so one bad step reports once.
    if (mismatch) mirror = mirrorOf(mode, res.snapshot);
    await sleep(ACTION_GAP_MS);
  }
  check(
    sent >= 4 && mismatches.length === 0,
    `${mode}: ${sent} scripted actions accepted, server events and snapshot match the local replay${mismatches.length ? ` (${mismatches.join("; ")})` : ""}`,
  );
  const missing = script.expectEvents.filter((t) => !events.has(t));
  check(
    missing.length === 0,
    `${mode}: results carry events ${script.expectEvents.join(", ")} (saw ${[...events].sort().join(", ")})`,
  );
  if (rtt.length)
    timings[`${mode}: action -> result (avg)`] = rtt.reduce((a, b) => a + b) / rtt.length;
  check(!bot.log.some((r) => r.msg.t === "error"), `${mode}: no error messages during play`);
  await bot.close();
  return { script, guest, mirror, hash: mirror.hash(), lastSeq, seq: seq + 1 };
}

export async function resume(baseUrl: string, run: PlayedInstance): Promise<void> {
  const { mode } = run.script;
  const bot = new InstanceBot(baseUrl, run.guest, mode);
  const state = await bot.join();
  timings[`${mode}: connect -> state after restart`] = performance.now() - bot.openedAt;
  const got = stableHash(state.snapshot);
  check(
    got === run.hash && state.lastSeq === run.lastSeq,
    `${mode}: after restart join resumes the persisted snapshot (hash ${got} vs ${run.hash}, lastSeq ${state.lastSeq} vs ${run.lastSeq})`,
  );

  // The run may be over (steps: the hero died). Then the resumed instance must
  // still reject the next action exactly like the local sim does.
  const next = run.script.next(run.mirror);
  const cmd = next ?? run.script.invalid(run.mirror);
  const { res, mismatch } = await actAndCompare(bot, run.mirror, run.seq, cmd);
  check(
    res.ok === (next !== null) && mismatch === null,
    `${mode}: after restart action ${run.seq} (${cmd[0]}${res.ok ? "" : `, rejected "${res.error?.code}"`}) matches the local replay${mismatch ? ` (${mismatch})` : ""}`,
  );

  const fresh = await bot.join(true);
  const freshHash = stableHash(fresh.snapshot);
  check(
    fresh.contentHash === loadedFor(mode).contentHash &&
      fresh.snapshot.tick === 0 &&
      freshHash !== run.mirror.hash(),
    `${mode}: fresh join resets the instance (tick ${fresh.snapshot.tick}, hash ${freshHash})`,
  );
  const mirror = mirrorOf(mode, fresh.snapshot);
  const first = run.script.next(mirror);
  if (first) {
    await sleep(ACTION_GAP_MS);
    const { res, mismatch } = await actAndCompare(bot, mirror, fresh.lastSeq + 1, first);
    check(
      res.ok && mismatch === null,
      `${mode}: fresh instance accepts seq ${fresh.lastSeq + 1} (${first[0]})${mismatch ? ` (${mismatch})` : ""}`,
    );
  }
  await bot.close();

  // A new connection must see the fresh instance, not the old run.
  const again = new InstanceBot(baseUrl, run.guest, mode);
  const back = await again.join();
  check(
    stableHash(back.snapshot) === mirror.hash(),
    `${mode}: reconnecting returns the fresh instance (hash ${stableHash(back.snapshot)})`,
  );
  await again.close();
}
