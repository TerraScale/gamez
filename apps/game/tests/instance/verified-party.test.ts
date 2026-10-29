/**
 * VerifiedHost with a party of the real classic mode (docs/design/party.md
 * §9, §11): the client records a segment with party inputs (recruit, control,
 * config, give, Auto play) and the host replays it to the same hash; a
 * tampered party input is refused; a stored solo base is carried over to new
 * content ("carried"); a party is carried over with its members; the party's
 * reports come out one row per member.
 */
import { createSim, loadMode, SegmentRecorder, type LoadedMode, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  packSnapshot,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { VerifiedHost } from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
/** The same modules, one bumped version: a new contentHash that carries over (same module ids). */
const bumped = loadMode(
  classic.mode,
  classic.modules.map((m) => (m.id === "classic.party" ? { ...m, version: "0.1.1" } : m)),
);
const policy = classic.mode.instance!.clientDriven!;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: "acc", name: "Tester", mode: "classic", joined: false };
  open = true;
  out: Out[] = [];
  setInfo(info: SocketInfo): void {
    this.info = info;
  }
  send(frame: string): void {
    this.out.push(JSON.parse(frame) as Out);
  }
  close(): void {
    this.open = false;
  }
}

/** One account's server: a shared store and outbox, restartable on any content. */
function setup(tunables: Readonly<Record<string, number>> = {}) {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const outbox = new Outbox(db.sql, "instance:classic:acc");
  outbox.init();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const logs: string[] = [];
  const make = (l: LoadedMode) =>
    new VerifiedHost({
      name: "classic:acc",
      loaded: l,
      policy,
      store,
      sockets: () => sockets.filter((s) => s.open),
      now: () => clock.now,
      randomSeed: () => 0x5eed,
      outbox,
      scheduleFlush: () => {},
      log: (_level, message) => {
        logs.push(message);
      },
      offlineTunables: async () => tunables,
    });
  const env = { host: make(loaded), clock, store, outbox, sockets };
  return {
    ...env,
    logs,
    restart(l: LoadedMode = loaded) {
      env.host = make(l);
    },
    connect(): Sock {
      const s = new Sock();
      sockets.push(s);
      return s;
    },
    async send(s: Sock, msg: VerifiedClientMessage): Promise<Out[]> {
      await env.host.handleMessage(s, JSON.stringify(msg));
      const out = s.out;
      s.out = [];
      return out;
    },
  };
}

class Client {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;
  constructor(readonly l: LoadedMode = loaded) {}
  async adopt(m: VState | Resync): Promise<void> {
    this.epoch = m.epoch;
    if (m.snapshot)
      this.sim = createSim(this.l, { seed: 0, from: await unpackSnapshot(m.snapshot) });
    this.rec = new SegmentRecorder(this.sim.tick);
  }
  act(name: string, payload: unknown): void {
    const res = this.sim.dispatch(name, payload, VERIFIED_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code} ${res.error?.message ?? ""}`).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }
  segment(ticks: number): Extract<VerifiedClientMessage, { t: "segment" }> {
    this.sim.step(ticks);
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...this.rec.cut(this.sim)! };
  }
}

/** Plays `ticks` in segments of `every`, advancing the wall clock by what the ledger charges. */
async function play(
  env: ReturnType<typeof setup>,
  sock: Sock,
  c: Client,
  ticks: number,
  every: number,
): Promise<number> {
  let acks = 0;
  for (let done = 0; done < ticks; done += every) {
    const speed = classic.classicSpeedOf(c.sim.world);
    env.clock.now += Math.ceil((every * 50) / speed);
    const out = await env.send(sock, c.segment(every));
    expect(out, JSON.stringify(out).slice(0, 300)).toHaveLength(1);
    expect(out[0]!.t).toBe("verified");
    if (out[0]!.t === "verified") expect(out[0]!.hash).toBe(c.sim.hash());
    acks++;
  }
  return acks;
}

/**
 * A base the server imports: a founder in town with 5000 gold and the depth-4
 * boss dead (the second slot unlocks), made by the same content.
 */
function partyBase(): Sim {
  const sim = createSim(loaded, { seed: 77 });
  expect(
    sim.dispatch(classic.ACTION.newHero, { classId: "classic.warrior", name: "Ardane" }, null).ok,
  ).toBe(true);
  sim.step(1);
  const hero = classic.heroOf(sim.world);
  sim.world.update(hero, classic.Wallet, { gold: 5000 });
  sim.world.getResource<classic.DungeonState>(classic.RES.dungeon)!.bossesKilled = [4];
  return sim;
}

describe("VerifiedHost with a party", () => {
  it("replays recruit, control, config, give and Auto play to the client hash", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);

    // Import the prepared base as the account's first progress (no progress yet).
    const base = partyBase();
    const imp = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(base.snapshot()),
      savedAt: 1,
    });
    expect(imp[0]!.t).toBe("vstate");
    await c.adopt(imp[0] as VState);

    const founder = classic.partyStateOf(c.sim.world)?.members[0] ?? classic.heroOf(c.sim.world);
    // Founder's starter bag items (if any) go to the second member.
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    const members = classic.partyStateOf(c.sim.world)!.members;
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(founder);
    const bag = c.sim.world.get(founder, classic.Inventory)?.items ?? [];
    if (bag.length > 0) {
      c.act(classic.ACTION.partyGive, { uid: bag[0]!.item.uid, to: members[1] });
    }
    c.act(classic.ACTION.partyConfig, { config: { formation: "line" } });
    c.act(classic.ACTION.partyControl, { hero: members[1] });
    c.act(classic.ACTION.setControl, { mode: "auto" });
    expect(await play(env, sock, c, 400, 100)).toBe(4);
    expect(env.host.sim!.hash()).toBe(c.sim.hash());
    expect(classic.partyStateOf(env.host.sim!.world)?.members).toHaveLength(2);
  }, 120_000);

  it("refuses a tampered party input and answers with a resync", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    const base = partyBase();
    const imp = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(base.snapshot()),
      savedAt: 1,
    });
    await c.adopt(imp[0] as VState);
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    await play(env, sock, c, 100, 100);

    const before = c.sim.hash();
    const bad = c.segment(20);
    // Control a hero that is not a member of the party.
    bad.inputs = [
      { tick: bad.fromTick, name: classic.ACTION.partyControl, payload: { hero: 999_999 } },
    ];
    env.clock.now += 1000;
    const r = (await env.send(sock, bad))[0] as Resync;
    expect(r.t).toBe("resync");
    expect(["input_rejected", "hash_mismatch"]).toContain(r.code);
    expect(r.hash).not.toBe(bad.hash);
    expect(r.hash).toBe(before);
  }, 120_000);

  it("carries a party over new content with its members and the same hash", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    const base = partyBase();
    const imp = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(base.snapshot()),
      savedAt: 1,
    });
    await c.adopt(imp[0] as VState);
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    c.act(classic.ACTION.setControl, { mode: "auto" });
    await play(env, sock, c, 200, 100);

    sock.open = false;
    await env.host.handleClose(sock);
    env.restart(bumped);
    const again = env.connect();
    const v = (await env.send(again, { t: "join", token: "t", mode: "classic" }))[0] as VState;
    expect(v.t).toBe("vstate");
    expect(v.contentHash).toBe(bumped.contentHash);
    expect(classic.partyStateOf(env.host.sim!.world)?.members).toHaveLength(2);
    const c2 = new Client(bumped);
    await c2.adopt(v);
    expect(c2.sim.hash()).toBe(v.hash);
    expect(await play(env, again, c2, 100, 100)).toBe(1);
  }, 120_000);

  it("writes one classic_hero report row per member (keys hero and hero:<uid>)", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    const base = partyBase();
    const imp = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(base.snapshot()),
      savedAt: 1,
    });
    await c.adopt(imp[0] as VState);
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    c.act(classic.ACTION.setControl, { mode: "auto" });
    await play(env, sock, c, 100, 100);
    // Reports are written on compaction (here: the socket closes after play).
    sock.open = false;
    await env.host.handleClose(sock);

    const keys = new Set(
      env.outbox
        .pending()
        .filter((r) => r.table === "classic_hero")
        .map((r) => r.pk),
    );
    expect(keys.has("classic:acc/hero")).toBe(true);
    expect(keys.has("classic:acc/hero:1")).toBe(true);
  }, 120_000);

  it("tombstones a dismissed member's classic_hero row (no recruit/dismiss board flooding)", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    const imp = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(partyBase().snapshot()),
      savedAt: 1,
    });
    await c.adopt(imp[0] as VState);
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    await play(env, sock, c, 100, 100);
    sock.open = false;
    await env.host.handleClose(sock);

    const ops = (pk: string) =>
      env.outbox
        .pending()
        .filter((r) => r.table === "classic_hero" && r.pk === pk)
        .map((r) => r.op);
    expect(ops("classic:acc/hero:1")).toEqual(["upsert"]);

    // Dismiss the recruit and recruit another one: hero:1 leaves, hero:2 arrives.
    const again = env.connect();
    const c2 = new Client();
    await c2.adopt(
      (await env.send(again, { t: "join", token: "t", mode: "classic" }))[0] as VState,
    );
    const recruit = classic.partyStateOf(c2.sim.world)!.members[1]!;
    c2.act(classic.ACTION.partyDismiss, { hero: recruit });
    c2.act(classic.ACTION.partyRecruit, { classId: "classic.sorcerer", name: "Wisp" });
    await play(env, again, c2, 100, 100);
    again.open = false;
    await env.host.handleClose(again);

    expect(ops("classic:acc/hero:1")).toEqual(["upsert", "delete"]);
    expect(ops("classic:acc/hero:2")).toEqual(["upsert"]);
    // Only the live members keep a report hash; the founder row was never tombstoned.
    expect(env.store.reportKeys("classic_hero")).toEqual(["hero", "hero:2"]);
    expect(ops("classic:acc/hero")).not.toContain("delete");
  }, 120_000);

  it("a solo save carried over to new content reports 'carried' and keeps its hero", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Solo" });
    c.act(classic.ACTION.setControl, { mode: "auto" });
    await play(env, sock, c, 200, 100);

    sock.open = false;
    await env.host.handleClose(sock);
    env.restart(bumped);
    const again = env.connect();
    const v = (await env.send(again, { t: "join", token: "t", mode: "classic" }))[0] as VState;
    expect(v.t).toBe("vstate");
    expect(v.contentHash).toBe(bumped.contentHash);
    expect(env.logs.some((m) => m.includes("carried over to " + bumped.contentHash))).toBe(true);
    // Carried: the hero is the same one, the party resource is still absent (solo).
    expect(classic.partyStateOf(env.host.sim!.world)).toBeNull();
    expect(classic.heroOf(env.host.sim!.world)).toBe(classic.heroOf(c.sim.world));
    expect(env.host.sim!.tick).toBe(c.sim.tick);
    expect(classic.partyStateOf(c.sim.world)).toBeNull();
  }, 120_000);

  it("members recruited by an imported (quarantined) founder stay quarantined (ADR 0007 R1)", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    // A client-authored local save: the server cannot verify the founder or its 5000 gold.
    const imp = await env.send(sock, {
      t: "import",
      snapshot: { enc: "json", data: partyBase().snapshot() },
      savedAt: 1,
    });
    expect((imp[0] as VState).imported).toBe(true);
    await c.adopt(imp[0] as VState);
    c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
    c.act(classic.ACTION.setControl, { mode: "auto" });
    await play(env, sock, c, 200, 100);
    sock.open = false;
    await env.host.handleClose(sock);

    // The quarantine is the instance's: the recruit (and anything it earns) is in it too.
    expect(env.store.load()?.imported).toBe(true);
    const rows = env.outbox.pending().filter((r) => r.table === "classic_hero");
    expect([...new Set(rows.map((r) => r.pk))].sort()).toEqual([
      "classic:acc/hero",
      "classic:acc/hero:1",
    ]);
    for (const r of rows) expect((r.payload as { imported: boolean }).imported, r.pk).toBe(true);
    // No arena build from the party either.
    expect(await env.host.exportBuild("Tester")).toBeNull();

    // Recruiting more members later, after a restart, keeps the flag.
    env.restart();
    const again = env.connect();
    const v = (await env.send(again, { t: "join", token: "t", mode: "classic" }))[0] as VState;
    expect(v.imported).toBe(true);
  }, 120_000);

  it("an offline grant splits XP per member with the admin's offlineXpPct (offline-idle.md §5.4)", async () => {
    const run = async (xpPct: number) => {
      const env = setup({ "classic.offlineXpPct": xpPct });
      const sock = env.connect();
      const c = new Client();
      await c.adopt(
        (await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState,
      );
      const imp = await env.send(sock, {
        t: "import",
        snapshot: { enc: "json", data: partyBase().snapshot() },
        savedAt: 1,
      });
      await c.adopt(imp[0] as VState);
      c.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Shade" });
      c.act(classic.ACTION.setControl, { mode: "idle" });
      await play(env, sock, c, 200, 100);
      sock.open = false;
      await env.host.handleClose(sock);
      env.clock.now += 3_600_000;
      const v = (await env.send(env.connect(), { t: "join", token: "t", mode: "classic" }))[0];
      expect(v!.t).toBe("vstate");
      const offline = (v as VState).offline;
      expect(offline).not.toBeNull();
      const members = classic.partyStateOf(env.host.sim!.world)!.members;
      const summary = offline!.events.find((e) => e.type === "classic.offline.summary") as
        | { xpPct: number; xp: number }
        | undefined;
      // The grant queued one grantXp per member: apply it on a copy of the granted state.
      const after = createSim(loaded, { seed: 0, from: env.host.sim!.snapshot() });
      after.step(1);
      const xpOf = (sim: Sim, e: number) => sim.world.read(e, classic.Level).xp;
      return {
        summary: summary!,
        members,
        xp: members.map((e) => xpOf(after, e) - xpOf(c.sim, e)),
      };
    };
    const half = await run(50);
    const none = await run(0);
    expect(half.summary.xpPct).toBe(50);
    expect(none.summary.xpPct).toBe(0);
    // Both members got their own XP at 50 %, none at 0 %.
    expect(half.members).toHaveLength(2);
    for (const xp of half.xp) expect(xp).toBeGreaterThan(0);
    expect(half.xp.reduce((a, b) => a + b, 0)).toBe(half.summary.xp);
    expect(none.summary.xp).toBe(0);
  }, 120_000);
});
