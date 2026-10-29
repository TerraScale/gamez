/**
 * Server-backed classic client (docs/design/wave-B.md §2.5-§2.7): ServerSync
 * wired into the real game controller, against an in-process fake InstanceDO
 * that verifies every segment with the kernel's replaySegment on its own sim
 * (so verification here is real, not mocked).
 */
import { describe, expect, it } from "vite-plus/test";
import {
  createSim,
  loadMode,
  replaySegment,
  type GameEvent,
  type LoadedMode,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import type { AssetManifest } from "@gamez/assets";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
  SegmentSubmission,
  VerifiedConnection,
  VerifiedHandlers,
  VerifiedState,
  VerifiedStatus,
} from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { mode, modules } from "../src/index.ts";
import { ACTION } from "../src/actions.ts";
import { classicClientDriven } from "../src/platform/policy.ts";
import { createClassicGame, type ClassicGame, type ServerHooks } from "../src/client/game.ts";
import { RES, type GameState } from "../src/resources.ts";
import {
  createSaveStore,
  DEFAULT_SETTINGS,
  legacySaveForImport,
  markLegacyMigrated,
  MIGRATED_SUFFIX,
  SAVE_KEY,
  type KeyValueStorage,
} from "../src/client/persist.ts";
import {
  DEFAULT_LIMITS,
  decodeSyncCache,
  serverSaveStore,
  ServerSync,
  SYNC_TEXT,
  syncCacheKey,
  wantsServer,
  type SyncBoot,
} from "../src/client/sync/index.ts";

// ---- fakes ------------------------------------------------------------------------

class FakeRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;
  frames: ((dt: number) => void)[] = [];
  entities = new Map<string, ArpgRenderEntity>();
  async init(_host: HTMLElement, _manifest: AssetManifest, _baseUrl: string): Promise<void> {}
  setMap(_map: TileMap): void {}
  upsertEntity(e: ArpgRenderEntity): void {
    this.entities.set(e.id, e);
  }
  removeEntity(id: string): void {
    this.entities.delete(id);
  }
  follow(_x: number, _y: number): void {}
  onTileTap(_cb: (x: number, y: number) => void): void {}
  showTapMarker(_x: number, _y: number): void {}
  onFrame(cb: (dtMs: number) => void): void {
    this.frames.push(cb);
  }
  destroy(): void {}
  floatText(_spec: FloatTextSpec): void {}
  playEffect(_spec: EffectSpec): void {}
  onPointer(_cb: (p: PointerInfo) => void): void {}
  snapCamera(_x: number, _y: number): void {}
  setZoom(_z: number): void {}
  getZoom(): number {
    return 1;
  }
  setLighting(_opts: { darkness: number; radius: number }): void {}
  tileAtClient(_x: number, _y: number): { x: number; y: number } | null {
    return null;
  }
  stats(): RendererStats {
    return { fps: 0, entities: this.entities.size, chunks: 0, props: 0, drawMs: 0 };
  }
  frame(dt: number): void {
    for (const cb of this.frames) cb(dt);
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Inbox =
  | { conn: FakeConnection; kind: "join"; fresh: boolean }
  | { conn: FakeConnection; kind: "segment"; seg: SegmentSubmission }
  | { conn: FakeConnection; kind: "import"; snapshot: SimSnapshot };

/**
 * The InstanceDO "classic:<account>" in miniature: verified base + epoch,
 * replays every segment on its own sim (replaySegment, expectHash), resyncs
 * on any failure, grants offline progress on join, imports once.
 */
class FakeServer {
  readonly loaded: LoadedMode;
  sim: Sim;
  base: SimSnapshot;
  epoch = 0;
  verifiedCount = 0;
  imported = false;
  down = false;
  /** Offline grant (ms) for the next join without pending segments. */
  grantMs: number | null = null;
  limits = { ...DEFAULT_LIMITS };
  readonly inbox: Inbox[] = [];
  readonly conns = new Set<FakeConnection>();
  readonly resyncs: string[] = [];
  readonly submitted: SegmentSubmission[] = [];
  readonly joins: { resume: ReturnType<VerifiedHandlers["resume"]>; fresh: boolean }[] = [];
  private seed = 7001;

  constructor(loaded: LoadedMode) {
    this.loaded = loaded;
    this.sim = createSim(loaded, { seed: this.seed });
    this.base = this.sim.snapshot();
  }

  get tick(): number {
    return this.sim.tick;
  }

  hash(): string {
    return this.sim.hash();
  }

  /** Changes the server state behind the client's back (a forced divergence). */
  tamper(): void {
    const r = this.sim.dispatch(ACTION.setControl, { mode: "manual" }, "server");
    if (!r.ok) throw new Error(`tamper failed: ${r.error?.message}`);
    this.base = this.sim.snapshot();
  }

  connect(conn: FakeConnection): void {
    this.conns.add(conn);
    conn.setStatus(this.down ? "offline" : "connecting");
    if (!this.down) this.inbox.push({ conn, kind: "join", fresh: false });
  }

  setDown(down: boolean): void {
    this.down = down;
    for (const c of this.conns) {
      if (down) c.setStatus("offline");
      else this.inbox.push({ conn: c, kind: "join", fresh: false });
    }
  }

  /** Delivers everything queued (in order), including what the answers trigger. */
  pump(): void {
    while (this.inbox.length > 0) {
      const m = this.inbox.shift();
      if (!m || m.conn.closed || this.down) continue;
      if (m.kind === "join") this.join(m.conn, m.fresh);
      else if (m.kind === "segment") this.segment(m.conn, m.seg);
      else this.importSave(m.conn, m.snapshot);
    }
  }

  private restore(): void {
    this.sim = createSim(this.loaded, { seed: 0, from: clone(this.base) });
  }

  private state(conn: FakeConnection, continued: boolean, offline: VerifiedState["offline"]): void {
    conn.handlers?.state({
      instanceId: "classic:acc",
      epoch: this.epoch,
      tick: this.sim.tick,
      hash: this.sim.hash(),
      continued,
      snapshot: continued ? null : clone(this.base),
      offline,
      imported: this.imported,
      importable: this.verifiedCount === 0 && !this.imported,
      limits: this.limits,
    });
  }

  private join(conn: FakeConnection, fresh: boolean): void {
    const resume = conn.handlers?.resume() ?? null;
    this.joins.push({ resume, fresh });
    if (fresh) {
      this.seed++;
      this.sim = createSim(this.loaded, { seed: this.seed });
      this.base = this.sim.snapshot();
      this.verifiedCount = 0;
      this.imported = false;
    }
    this.epoch++;
    conn.setStatus("online");
    let continued =
      !fresh && resume !== null && resume.tick === this.sim.tick && resume.hash === this.hash();
    let offline: VerifiedState["offline"] = null;
    const policy = classicClientDriven.offline;
    if (
      this.grantMs !== null &&
      policy &&
      resume?.pending !== true &&
      policy.eligible(this.sim.world)
    ) {
      const elapsedMs = this.grantMs;
      const r = this.sim.dispatch(policy.action, { elapsedMs }, "server");
      this.grantMs = null;
      if (r.ok) {
        this.base = this.sim.snapshot();
        offline = { elapsedMs, events: clone(r.events) };
        continued = false;
      }
    }
    this.state(conn, continued, offline);
  }

  private resync(conn: FakeConnection, seq: number, code: string): void {
    this.restore();
    this.epoch++;
    this.resyncs.push(code);
    conn.handlers?.resync({
      epoch: this.epoch,
      seq,
      code,
      message: code,
      tick: this.sim.tick,
      hash: this.sim.hash(),
      snapshot: clone(this.base),
    });
  }

  private segment(conn: FakeConnection, seg: SegmentSubmission): void {
    this.submitted.push(seg);
    if (seg.epoch !== this.epoch) return;
    if (seg.toTick <= this.sim.tick) {
      conn.handlers?.verified({
        epoch: this.epoch,
        seq: seg.seq,
        tick: this.sim.tick,
        hash: this.hash(),
        creditMs: 1000,
      });
      return;
    }
    if (seg.fromTick !== this.sim.tick) {
      this.resync(conn, seg.seq, "gap");
      return;
    }
    const out = replaySegment(this.sim, clone(seg), {
      actor: "local",
      maxTicks: classicClientDriven.maxTicksPerSegment,
      maxInputs: classicClientDriven.maxInputsPerSegment,
      serverOnly: new Set(classicClientDriven.serverOnlyActions),
      speedOf: (w) => classicClientDriven.speedOf(w),
      maxSpeed: classicClientDriven.maxSpeed,
      expectHash: seg.hash,
    });
    if (!out.ok) {
      this.resync(conn, seg.seq, out.code);
      return;
    }
    this.base = this.sim.snapshot();
    this.verifiedCount++;
    conn.handlers?.verified({
      epoch: this.epoch,
      seq: seg.seq,
      tick: this.sim.tick,
      hash: out.hash,
      creditMs: 1000,
    });
  }

  private importSave(conn: FakeConnection, snapshot: SimSnapshot): void {
    if (this.verifiedCount > 0 || this.imported) {
      conn.handlers?.error?.("not_importable", "instance has progress");
      return;
    }
    this.sim = createSim(this.loaded, { seed: 0, from: clone(snapshot) });
    this.base = this.sim.snapshot();
    this.imported = true;
    this.epoch++;
    this.state(conn, false, null);
  }
}

class FakeConnection implements VerifiedConnection {
  readonly mode = "classic";
  status: VerifiedStatus = "connecting";
  handlers: VerifiedHandlers | null = null;
  closed = false;
  constructor(readonly server: FakeServer) {}
  setStatus(s: VerifiedStatus): void {
    this.status = s;
    this.handlers?.status(s);
  }
  start(h: VerifiedHandlers): void {
    this.handlers = h;
    this.server.connect(this);
  }
  submit(seg: SegmentSubmission): boolean {
    if (this.status !== "online" || this.closed) return false;
    this.server.inbox.push({ conn: this, kind: "segment", seg: clone(seg) });
    return true;
  }
  importSave(snapshot: SimSnapshot, _savedAt: number): void {
    this.server.inbox.push({ conn: this, kind: "import", snapshot: clone(snapshot) });
  }
  restart(): void {
    this.server.inbox.push({ conn: this, kind: "join", fresh: true });
  }
  serverNow(): number {
    return 0;
  }
  close(): void {
    this.closed = true;
    this.status = "closed";
    this.server.conns.delete(this);
  }
}

// ---- harness ----------------------------------------------------------------------

const LOADED = loadMode(mode, modules);

interface Client {
  sync: ServerSync;
  game: ClassicGame;
  renderer: FakeRenderer;
  clock: { now: number; wall: number };
  timers: (() => void)[];
  /** Dispatches seen by the recorder hook (to check each act is recorded exactly once). */
  recorded: { tick: number; name: string }[];
  conns: FakeConnection[];
}

function newSync(
  server: FakeServer,
  storage: MemoryStorage,
  clock: { now: number; wall: number },
  timers: (() => void)[],
  conns: FakeConnection[],
): ServerSync {
  return new ServerSync({
    loaded: LOADED,
    accountId: "acc",
    connect: () => {
      const c = new FakeConnection(server);
      conns.push(c);
      return c;
    },
    storage,
    now: () => clock.now,
    wall: () => clock.wall,
    legacy: {
      load: () => legacySaveForImport(storage, LOADED),
      markMigrated: () => {
        markLegacyMigrated(storage);
      },
    },
    setTimer: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    clearTimer: () => {},
  });
}

/** Boots a client page (cache or server), creates the game and attaches it. */
async function openClient(
  server: FakeServer,
  storage: MemoryStorage,
  opts: { expectBoot?: SyncBoot["from"] } = {},
): Promise<Client & { boot: SyncBoot }> {
  const clock = { now: 1000, wall: 1_800_000_000_000 };
  const timers: (() => void)[] = [];
  const conns: FakeConnection[] = [];
  const sync = newSync(server, storage, clock, timers, conns);
  const pending = sync.boot();
  server.pump();
  const boot = await pending;
  if (boot === null) throw new Error("boot failed");
  if (opts.expectBoot) expect(boot.from).toBe(opts.expectBoot);
  const recorded: { tick: number; name: string }[] = [];
  const renderer = new FakeRenderer();
  // Spy on the hook: every successful act must reach dispatched() exactly once.
  const hooks: ServerHooks = {
    dispatched(tick, name, payload) {
      recorded.push({ tick, name });
      sync.dispatched(tick, name, payload);
    },
    refuse: (name) => sync.refuse(name),
    room: (sim) => sync.room(sim),
    stepped: (sim, now) => sync.stepped(sim, now),
    newGame: (seed) => sync.newGame(seed),
  };
  const game = createClassicGame({
    loaded: LOADED,
    sim: boot.sim,
    renderer,
    save: serverSaveStore(sync),
    settings: boot.settings ?? { ...DEFAULT_SETTINGS },
    now: () => clock.now,
    wall: () => clock.wall,
    newSeed: () => 4242,
    viewportWidth: () => 1024,
    exit: () => {},
    server: hooks,
    sync: sync.view,
  });
  sync.attach(game);
  server.pump();
  return { sync, game, renderer, clock, timers, recorded, conns, boot };
}

/** Runs `ms` of wall time in 50 ms frames, delivering server traffic after each frame. */
function play(c: Client, server: FakeServer, ms: number): void {
  for (let t = 0; t < ms; t += 50) {
    c.clock.now += 50;
    c.clock.wall += 50;
    c.renderer.frame(50);
    server.pump();
  }
}

function newHero(c: Client, classId = "classic.warrior"): void {
  const r = c.game.api.act(ACTION.newHero, { classId, name: "Sync" });
  expect(r.ok, r.error?.message).toBe(true);
}

function toastTitles(c: Client): string[] {
  return c.game.api.ui.getSnapshot().toasts.map((t) => t.title);
}

// ---- tests ------------------------------------------------------------------------

describe("server mode selection", () => {
  it("uses the server only for unseeded, cheat-free runs on a host that can connect", () => {
    expect(wantsServer({ canConnect: true, seed: null, cheats: false })).toBe(true);
    expect(wantsServer({ canConnect: false, seed: null, cheats: false })).toBe(false);
    expect(wantsServer({ canConnect: true, seed: 4242, cheats: false })).toBe(false);
    expect(wantsServer({ canConnect: true, seed: null, cheats: true })).toBe(false);
  });
});

describe("ServerSync recording and verification", () => {
  it("records every act once, cuts only after steps, and honest play verifies", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage(), { expectBoot: "server" });
    expect(c.sync.view.getSnapshot()).toMatchObject({ mode: "server", status: "online" });
    newHero(c);
    let acts = 1;
    for (let i = 0; i < 12; i++) {
      play(c, server, 700);
      const mode = i % 3 === 0 ? "manual" : i % 3 === 1 ? "idle" : "auto";
      expect(c.game.api.act(ACTION.setControl, { mode }).ok).toBe(true);
      acts++;
      if (mode === "idle") {
        expect(c.game.api.act(ACTION.setSpeed, { speed: 8 }).ok).toBe(true);
        acts++;
      }
      // Two inputs at the same tick keep their order.
      if (mode === "manual") {
        expect(c.game.api.act(ACTION.setControl, { mode: "auto" }).ok).toBe(true);
        expect(c.game.api.act(ACTION.setControl, { mode: "manual" }).ok).toBe(true);
        acts += 2;
      }
    }
    // A refused dispatch is not recorded.
    expect(c.game.api.act(ACTION.setSpeed, { speed: 3 }).ok).toBe(false);
    play(c, server, 2500);
    const sim = c.game.currentSim();

    expect(c.recorded).toHaveLength(acts);
    const sent = server.submitted.flatMap((s) => s.inputs);
    expect(sent.length + c.sync.recorder.inputs.length).toBe(acts);
    expect(sent.map((i) => i.name)).toEqual(c.recorded.slice(0, sent.length).map((r) => r.name));
    // Segments are contiguous, inputs strictly inside each segment.
    let at = server.submitted[0]?.fromTick ?? 0;
    for (const s of server.submitted) {
      expect(s.fromTick).toBe(at);
      expect(s.toTick - s.fromTick).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTicksPerSegment);
      for (const i of s.inputs) {
        expect(i.tick).toBeGreaterThanOrEqual(s.fromTick);
        expect(i.tick).toBeLessThan(s.toTick);
      }
      at = s.toTick;
    }
    expect(server.resyncs).toEqual([]);
    expect(server.verifiedCount).toBe(server.submitted.length);
    expect(c.sync.pending).toHaveLength(0);
    expect(c.sync.verified).toEqual({ tick: server.tick, hash: server.hash() });
    expect(sim.tick - server.tick).toBeLessThan(200);
    const v = c.sync.view.getSnapshot();
    expect(v.verifiedTick).toBe(server.tick);
    expect(v.overflow).toBe(false);
  }, 30_000);

  it("keeps x8 Full Idle segments within the tick limit", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    c.game.api.act(ACTION.setControl, { mode: "idle" });
    c.game.api.act(ACTION.setSpeed, { speed: 8 });
    // Big frames: the loop asks for up to 160 ticks per frame.
    for (let i = 0; i < 12; i++) {
      c.clock.now += 1000;
      c.renderer.frame(1000);
      server.pump();
    }
    expect(server.submitted.length).toBeGreaterThan(3);
    for (const s of server.submitted) {
      expect(s.toTick - s.fromTick).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTicksPerSegment);
    }
    expect(server.resyncs).toEqual([]);
    // About 7 s on a loaded machine (12 frames of 160 ticks at x8, replayed by the fake server).
  }, 30_000);

  it("refuses server-only actions in server mode", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    const r = c.game.api.act(ACTION.offlineProgress, { elapsedMs: 3_600_000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("server_only");
    expect(c.recorded.map((x) => x.name)).toEqual([ACTION.newHero]);
  });

  it("a forced mismatch resyncs: the sim and the recorder are replaced, play verifies again", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    play(c, server, 3000);
    const before = c.game.currentSim();
    server.tamper();
    play(c, server, 2500);
    expect(server.resyncs).toEqual(["hash_mismatch"]);
    const after = c.game.currentSim();
    expect(after).not.toBe(before);
    expect(c.sync.view.getSnapshot().lastResync?.code).toBe("hash_mismatch");
    expect(toastTitles(c)).toContain(SYNC_TEXT.resyncTitle);
    expect(c.game.api.log.getSnapshot().some((l) => l.text.includes("hash_mismatch"))).toBe(true);
    // The server's change (manual control) is now the local state too.
    expect(c.game.api.hud.getSnapshot().control.mode).toBe("manual");
    const verifiedBefore = server.verifiedCount;
    play(c, server, 5000);
    expect(server.resyncs).toEqual(["hash_mismatch"]);
    expect(server.verifiedCount).toBeGreaterThan(verifiedBefore);
    expect(c.sync.verified).toEqual({ tick: server.tick, hash: server.hash() });
  });
});

describe("disconnected play and overflow", () => {
  it("buffers while offline and flushes in order on reconnect", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    play(c, server, 2500);
    server.setDown(true);
    play(c, server, 3000);
    c.game.api.act(ACTION.setControl, { mode: "manual" });
    play(c, server, 3000);
    expect(c.sync.pending.length).toBeGreaterThan(1);
    expect(c.sync.view.getSnapshot().status).toBe("offline");
    server.setDown(false);
    server.pump();
    expect(server.joins.at(-1)?.resume?.pending).toBe(true);
    expect(server.resyncs).toEqual([]);
    expect(c.sync.pending).toHaveLength(0);
    expect(c.sync.verified?.tick).toBe(server.tick);
  });

  it("stops recording beyond maxPendingTicks and adopts the server state on the next join", async () => {
    const server = new FakeServer(LOADED);
    server.limits = { ...DEFAULT_LIMITS, maxPendingTicks: 120 };
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    play(c, server, 2500);
    const verifiedTick = server.tick;
    server.setDown(true);
    play(c, server, 9000);
    expect(c.sync.view.getSnapshot().overflow).toBe(true);
    const recordedBefore = c.recorded.length;
    c.game.api.act(ACTION.setControl, { mode: "manual" });
    expect(c.recorded.length).toBe(recordedBefore + 1);
    expect(c.sync.recorder.inputs).toHaveLength(0);
    const local = c.game.currentSim();
    expect(local.tick).toBeGreaterThan(verifiedTick + 120);
    server.setDown(false);
    server.pump();
    expect(server.joins.at(-1)?.resume).toBeNull();
    expect(c.game.currentSim()).not.toBe(local);
    expect(c.game.currentSim().tick).toBe(verifiedTick);
    expect(c.sync.view.getSnapshot().overflow).toBe(false);
    expect(toastTitles(c)).toContain(SYNC_TEXT.replacedTitle);
    play(c, server, 3000);
    expect(server.resyncs).toEqual([]);
    expect(c.sync.verified?.tick).toBe(server.tick);
  });
});

describe("local cache", () => {
  it("a reload resumes from the cache with continued and flushes pending segments", async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer(LOADED);
    const a = await openClient(server, storage);
    newHero(a);
    play(a, server, 3000);
    server.setDown(true);
    play(a, server, 3000);
    a.game.api.act(ACTION.setControl, { mode: "idle" });
    play(a, server, 300);
    expect(a.sync.pending.length).toBeGreaterThan(0);
    expect(a.game.save()).toBe(true);
    const old = a.game.currentSim();
    const rec = decodeSyncCache(storage.getItem(syncCacheKey("acc")), "acc", LOADED.contentHash);
    expect(rec?.overflow).toBe(false);
    expect(rec?.pending.length).toBe(a.sync.pending.length);
    a.sync.destroy();
    a.game.destroy();

    server.setDown(false);
    const b = await openClient(server, storage, { expectBoot: "cache" });
    expect(b.boot.sim.tick).toBe(old.tick);
    expect(b.boot.sim.hash()).toBe(old.hash());
    // Resumed: continued, so the boot sim is still the game's sim.
    expect(server.joins.at(-1)?.resume).toMatchObject({ pending: true });
    expect(b.game.currentSim()).toBe(b.boot.sim);
    expect(b.sync.pending).toHaveLength(0);
    expect(server.verifiedCount).toBeGreaterThan(0);
    // The open segment (with its idle input) continues and verifies.
    play(b, server, 2500);
    expect(server.resyncs).toEqual([]);
    expect(b.sync.verified?.tick).toBe(server.tick);
    expect(b.game.api.hud.getSnapshot().control.mode).toBe("idle");
  });

  it("ignores a cache of another account or content", async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer(LOADED);
    const a = await openClient(server, storage);
    newHero(a);
    play(a, server, 2500);
    a.game.save();
    const text = storage.getItem(syncCacheKey("acc"));
    expect(decodeSyncCache(text, "other", LOADED.contentHash)).toBeNull();
    expect(decodeSyncCache(text, "acc", "deadbeef")).toBeNull();
    expect(decodeSyncCache("{oops", "acc", LOADED.contentHash)).toBeNull();
  });
});

describe("offline progress and long hidden tabs", () => {
  it("rejoins after a long hidden tab and fans out the server's offline grant", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c);
    play(c, server, 3000);
    c.sync.flush();
    server.pump();
    expect(c.sync.pending).toHaveLength(0);
    server.grantMs = 2 * 3600_000;
    const before = c.game.currentSim();
    c.sync.visible(30_000);
    server.pump();
    expect(c.game.currentSim()).toBe(before);
    c.sync.visible(90_000);
    server.pump();
    expect(server.joins.at(-1)?.resume).toMatchObject({ pending: false });
    expect(c.game.currentSim()).not.toBe(before);
    expect(c.game.api.ui.getSnapshot().toasts.some((t) => t.kind === "offline")).toBe(true);
    play(c, server, 2500);
    expect(server.resyncs).toEqual([]);
  });
});

describe("new game", () => {
  it("restarts the server instance and replays the placeholder's inputs on the fresh state", async () => {
    const server = new FakeServer(LOADED);
    const c = await openClient(server, new MemoryStorage());
    newHero(c, "classic.rogue");
    play(c, server, 3000);
    c.game.api.newGame();
    expect(c.game.api.hud.getSnapshot().phase).toBe("choose");
    newHero(c, "classic.sorcerer");
    play(c, server, 300);
    // Nothing is submitted for the placeholder.
    const sentBefore = server.submitted.length;
    expect(server.joins.at(-1)?.fresh).toBe(true);
    expect(server.submitted.length).toBe(sentBefore);
    play(c, server, 3000);
    expect(server.resyncs).toEqual([]);
    expect(c.game.api.hud.getSnapshot().hero?.classId).toBe("classic.sorcerer");
    expect(c.sync.verified?.tick).toBe(server.tick);
    // The server's sim has the new hero too (its seed, not the client's).
    const game = server.sim.world.getResource<GameState>(RES.game);
    expect(game?.hero).toBeGreaterThan(0);
  });
});

describe("reset progress", () => {
  it("newGame drops the per-account sync cache so a reload cannot restore the old hero", async () => {
    const server = new FakeServer(LOADED);
    const storage = new MemoryStorage();
    const c = await openClient(server, storage);
    newHero(c, "classic.rogue");
    play(c, server, 3000);
    c.game.save();
    // Whatever the cache holds at this point, a new game must remove it.
    if (storage.getItem(syncCacheKey("acc")) === null) storage.setItem(syncCacheKey("acc"), "old");
    c.game.api.newGame();
    expect(storage.getItem(syncCacheKey("acc"))).toBeNull();
    newHero(c, "classic.sorcerer");
    play(c, server, 300);
    expect(server.joins.at(-1)?.fresh).toBe(true);
  });
});

describe("legacy save import (§2.7)", () => {
  function legacySave(storage: MemoryStorage): Sim {
    const sim = createSim(LOADED, { seed: 99 });
    sim.dispatch(ACTION.newHero, { classId: "classic.rogue", name: "Legacy" }, "local");
    sim.step(40);
    createSaveStore(storage).save({
      v: 1,
      savedAt: 1_700_000_000_000,
      snapshot: sim.snapshot(),
      settings: { ...DEFAULT_SETTINGS, zoom: 1.5 },
      modules: LOADED.modules.map((m) => m.id),
    });
    return sim;
  }

  it("imports the local save into an empty instance and keeps a backup", async () => {
    const storage = new MemoryStorage();
    const legacy = legacySave(storage);
    const server = new FakeServer(LOADED);
    const c = await openClient(server, storage, { expectBoot: "server" });
    expect(server.imported).toBe(true);
    expect(c.boot.sim.hash()).toBe(legacy.hash());
    expect(c.boot.settings?.zoom).toBe(1.5);
    expect(storage.getItem(SAVE_KEY)).toBeNull();
    expect(storage.getItem(`${SAVE_KEY}${MIGRATED_SUFFIX}`)).not.toBeNull();
    expect(toastTitles(c)).toContain(SYNC_TEXT.importTitle);
    expect(c.sync.view.getSnapshot().imported).toBe(true);
    play(c, server, 2500);
    expect(server.resyncs).toEqual([]);
    expect(server.verifiedCount).toBeGreaterThan(0);
  });

  it("leaves the legacy save untouched when the server already has progress", async () => {
    const server = new FakeServer(LOADED);
    const first = await openClient(server, new MemoryStorage());
    newHero(first, "classic.warrior");
    play(first, server, 2500);
    first.sync.destroy();
    const storage = new MemoryStorage();
    legacySave(storage);
    const c = await openClient(server, storage, { expectBoot: "server" });
    expect(server.imported).toBe(false);
    expect(storage.getItem(SAVE_KEY)).not.toBeNull();
    expect(c.game.api.hud.getSnapshot().hero?.classId).toBe("classic.warrior");
  });
});

describe("boot without a server", () => {
  it("resolves null after the timeout so the client falls back to local mode", async () => {
    const server = new FakeServer(LOADED);
    server.down = true;
    const clock = { now: 0, wall: 0 };
    const timers: (() => void)[] = [];
    const sync = newSync(server, new MemoryStorage(), clock, timers, []);
    const pending = sync.boot(8000);
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await expect(pending).resolves.toBeNull();
    sync.destroy();
  });

  it("emits nothing for a game without server hooks (local mode unchanged)", () => {
    const sim = createSim(LOADED, { seed: 5 });
    const renderer = new FakeRenderer();
    const events: GameEvent[] = [];
    const game = createClassicGame({
      loaded: LOADED,
      sim,
      renderer,
      save: createSaveStore(new MemoryStorage()),
      settings: { ...DEFAULT_SETTINGS },
      now: () => 0,
      wall: () => 0,
      newSeed: () => 1,
      viewportWidth: () => 1024,
      exit: () => {},
      onEvents: (e) => events.push(...e),
    });
    expect(game.api.sync?.getSnapshot().mode).toBe("local");
    // Local mode still allows the local offline-progress dispatch.
    game.api.act(ACTION.newHero, { classId: "classic.warrior", name: "Local" });
    expect(game.api.act(ACTION.offlineProgress, { elapsedMs: 120_000 }).ok).toBe(true);
  });
});
