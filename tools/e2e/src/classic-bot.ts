/**
 * A scripted classic player over /ws/instance (wave-B.md §2, §10). OWNER:
 * T-verify.
 *
 * It runs the real classic sim locally (loadMode(classic.mode, classic.modules)),
 * records inputs with SegmentRecorder, and submits segments exactly like the
 * browser client, so the server's replay must agree. play() paces itself
 * against the server's wall-time credit ledger (it never claims more sim time
 * than the credit the last ack reported plus the wall time since), so honest
 * play verifies; tamper tests send raw frames with sendRaw().
 */
import {
  createSim,
  loadMode,
  SegmentRecorder,
  type LoadedMode,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  packSnapshot,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type PackedSnapshot,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import type { Guest } from "./client.ts";

export type VState = Extract<VerifiedServerMessage, { t: "vstate" }>;
export type Resync = Extract<VerifiedServerMessage, { t: "resync" }>;
export type Ack = Extract<VerifiedServerMessage, { t: "verified" }>;

export interface PlayResult {
  /** Segments acked with "verified". */
  verified: number;
  resyncs: Resync[];
  /** Server verified tick after the last ack. */
  tick: number;
}

export interface JoinOptions {
  /** New server instance (server seed). */
  fresh?: boolean;
  classId?: string;
  heroName?: string;
  /**
   * Continue from a verified snapshot kept from an earlier bot (persistence
   * checks): the join sends resume {tick, hash, pending} for it, and the bot
   * keeps that sim when the server answers continued.
   */
  resumeFrom?: SimSnapshot;
  pending?: boolean;
  /** Skip hero creation (inspect a fresh instance). */
  noHero?: boolean;
}

let loadedCache: LoadedMode | null = null;
/** The classic mode exactly as the server loads it (same catalog modules). */
export function classicLoaded(): LoadedMode {
  loadedCache ??= loadMode(classic.mode, classic.modules);
  return loadedCache;
}

const MS_PER_TICK = 1000 / classic.CLASSIC_HZ;
/** The server's START_CREDIT_MS (new games, imports, offline grants). */
const START_CREDIT_MS = 3000;
/** How far below zero the bot lets its credit estimate go (the server tolerates 2000). */
const OVERDRAW_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ClassicBot {
  readonly log: VerifiedServerMessage[] = [];
  readonly guest: Guest;
  readonly closed: Promise<CloseEvent>;
  #sim!: Sim;
  #vstate!: VState;
  #rec!: SegmentRecorder;
  #epoch = 0;
  #seq = 0;
  #verifiedTick = 0;
  #verifiedHash = "";
  /** Index of the next log entry waitFor() may return. */
  #cursor = 0;
  /** Credit estimate (ms) at #creditAt (performance.now()). */
  #credit = 0;
  #creditAt = 0;
  readonly #ws: WebSocket;
  readonly #waiters = new Set<() => void>();

  private constructor(url: string, guest: Guest) {
    this.guest = guest;
    const q = `token=${encodeURIComponent(guest.token)}&mode=classic`;
    this.#ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws/instance?${q}`);
    this.#ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) => {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      this.log.push(JSON.parse(text) as VerifiedServerMessage);
      for (const wake of this.#waiters) wake();
    });
    this.closed = new Promise((resolve) => this.#ws.addEventListener("close", resolve));
  }

  get sim(): Sim {
    return this.#sim;
  }

  /** The last vstate (join, import). */
  get vstate(): VState {
    return this.#vstate;
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** Server-verified tick and hash (from the last vstate, ack or adopted resync). */
  get verified(): { tick: number; hash: string } {
    return { tick: this.#verifiedTick, hash: this.#verifiedHash };
  }

  /**
   * Connects and joins (fresh: new server instance), adopts the server
   * snapshot, and when no hero exists creates one (classId, name) and sets
   * control "auto".
   */
  static async join(url: string, guest: Guest, opts: JoinOptions = {}): Promise<ClassicBot> {
    const bot = new ClassicBot(url, guest);
    await new Promise<void>((resolve, reject) => {
      bot.#ws.addEventListener("open", () => resolve(), { once: true });
      bot.#ws.addEventListener("error", () => reject(new Error("classic: socket error")), {
        once: true,
      });
    });
    await bot.rejoin(opts);
    if (!opts.noHero && classic.heroOf(bot.#sim.world) === 0) {
      bot.act(classic.ACTION.newHero, {
        classId: opts.classId ?? "classic.warrior",
        name: opts.heroName ?? "Verity",
      });
      bot.act(classic.ACTION.setControl, { mode: "auto" });
    }
    return bot;
  }

  /** Sends join again on this socket (resume from the local sim unless fresh) and adopts the answer. */
  async rejoin(opts: Pick<JoinOptions, "fresh" | "resumeFrom" | "pending"> = {}): Promise<VState> {
    const loaded = classicLoaded();
    const msg: Extract<VerifiedClientMessage, { t: "join" }> = {
      t: "join",
      token: this.guest.token,
      mode: "classic",
    };
    let local: Sim | null = null;
    if (opts.fresh) msg.fresh = true;
    else if (opts.resumeFrom) {
      local = createSim(loaded, { seed: 0, from: opts.resumeFrom });
      msg.resume = { tick: local.tick, hash: local.hash(), pending: opts.pending ?? false };
    }
    this.sendRaw(msg);
    const v = await this.waitFor("vstate", (m): m is VState => m.t === "vstate");
    this.#vstate = v;
    this.#epoch = v.epoch;
    this.#verifiedTick = v.tick;
    this.#verifiedHash = v.hash;
    if (v.snapshot) {
      this.#sim = createSim(loaded, { seed: 0, from: await unpackSnapshot(v.snapshot) });
    } else if (local) {
      this.#sim = local;
    } else if (!this.#sim) {
      throw new Error("classic: continued without a local sim");
    }
    this.#rec = new SegmentRecorder(this.#sim.tick);
    // A continued join keeps the ledger's credit (unknown here): assume none.
    this.#setCredit(v.continued ? 0 : START_CREDIT_MS);
    return v;
  }

  /**
   * Sends a legacy-save import (`snapshot`, or a raw packed frame for tamper
   * tests) and waits for the answer. A vstate is adopted like a join (the bot
   * continues from the imported sim); an error is returned as-is.
   */
  async importSave(
    snapshot: SimSnapshot | PackedSnapshot,
  ): Promise<{ vstate: VState } | { error: Extract<VerifiedServerMessage, { t: "error" }> }> {
    const packed: PackedSnapshot =
      "enc" in snapshot ? (snapshot as PackedSnapshot) : await packSnapshot(snapshot);
    this.sendRaw({ t: "import", snapshot: packed, savedAt: Date.now() });
    const m = await this.waitFor(
      "import answer",
      (x): x is VState | Extract<VerifiedServerMessage, { t: "error" }> =>
        x.t === "vstate" || x.t === "error",
    );
    if (m.t === "error") return { error: m };
    this.#vstate = m;
    this.#epoch = m.epoch;
    this.#verifiedTick = m.tick;
    this.#verifiedHash = m.hash;
    if (m.snapshot) {
      this.#sim = createSim(classicLoaded(), { seed: 0, from: await unpackSnapshot(m.snapshot) });
    }
    this.#rec = new SegmentRecorder(this.#sim.tick);
    this.#setCredit(START_CREDIT_MS);
    return { vstate: m };
  }

  /** Dispatches locally and records the input (throws when the sim rejects it). */
  act(name: string, payload: unknown): void {
    const res = this.#sim.dispatch(name, payload, VERIFIED_ACTOR);
    if (!res.ok) throw new Error(`classic: ${name} rejected (${res.error?.code})`);
    this.#rec.record(this.#sim.tick, name, payload);
  }

  /** Steps `ticks` locally in chunks, cutting a segment every `segmentTicks` (default 100) and awaiting acks. */
  async play(ticks: number, opts: { segmentTicks?: number } = {}): Promise<PlayResult> {
    const every = Math.max(1, opts.segmentTicks ?? 100);
    const result: PlayResult = { verified: 0, resyncs: [], tick: this.#verifiedTick };
    for (let done = 0; done < ticks;) {
      const n = Math.min(every, ticks - done);
      const speed = Math.min(8, Math.max(1, classic.classicSpeedOf(this.#sim.world)));
      const cost = (n * MS_PER_TICK) / speed;
      const wait = cost - OVERDRAW_MS - this.#creditNow();
      if (wait > 0) await sleep(wait);
      this.#sim.step(n);
      done += n;
      const seg = this.#rec.cut(this.#sim)!;
      const seq = ++this.#seq;
      this.sendRaw({ t: "segment", epoch: this.#epoch, seq, ...seg });
      const answer = await this.waitFor(
        `ack of segment ${seq}`,
        (m): m is Ack | Resync => (m.t === "verified" || m.t === "resync") && m.seq === seq,
      );
      if (answer.t === "verified") {
        this.#verifiedTick = answer.tick;
        this.#verifiedHash = answer.hash;
        this.#setCredit(answer.creditMs);
        result.verified++;
      } else {
        result.resyncs.push(answer);
        await this.adopt(answer);
        this.#setCredit(this.#creditNow() - cost);
      }
      result.tick = this.#verifiedTick;
    }
    return result;
  }

  /** Replaces the local sim with a resync's snapshot (what the browser does). */
  async adopt(r: Resync): Promise<void> {
    this.#epoch = r.epoch;
    this.#verifiedTick = r.tick;
    this.#verifiedHash = r.hash;
    this.#sim = createSim(classicLoaded(), { seed: 0, from: await unpackSnapshot(r.snapshot) });
    this.#rec = new SegmentRecorder(this.#sim.tick);
  }

  /** Steps locally and cuts a segment without sending it (tamper tests). */
  cut(ticks: number): Extract<VerifiedClientMessage, { t: "segment" }> {
    this.#sim.step(ticks);
    const seg = this.#rec.cut(this.#sim)!;
    return { t: "segment", epoch: this.#epoch, seq: ++this.#seq, ...seg };
  }

  /** Sends any raw client frame (tamper tests). */
  sendRaw(msg: unknown): void {
    this.#ws.send(JSON.stringify(msg));
  }

  /**
   * Next server message matching `pred`, searching the log from the last
   * message a previous waitFor() returned (or from `from`); throws after
   * `timeoutMs`.
   */
  async waitFor<M extends VerifiedServerMessage>(
    what: string,
    pred: (m: VerifiedServerMessage) => m is M,
    timeoutMs = 10_000,
    from = this.#cursor,
  ): Promise<M> {
    return new Promise<M>((resolve, reject) => {
      const check = (): boolean => {
        for (let i = from; i < this.log.length; i++) {
          const m = this.log[i]!;
          if (pred(m)) {
            done();
            this.#cursor = Math.max(this.#cursor, i + 1);
            resolve(m);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        const errors = this.log.filter((m) => m.t === "error").map((m) => JSON.stringify(m));
        reject(
          new Error(
            `classic: timed out waiting for ${what}${errors.length ? `; errors: ${errors.join(", ")}` : ""}`,
          ),
        );
      }, timeoutMs);
      const wake = (): void => void check();
      const done = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
      };
      if (!check()) this.#waiters.add(wake);
    });
  }

  /** The local sim's snapshot at the verified tick (only valid right after an ack). */
  verifiedSnapshot(): SimSnapshot {
    if (this.#sim.tick !== this.#verifiedTick || this.#sim.hash() !== this.#verifiedHash) {
      throw new Error("classic: local sim is not at the verified state");
    }
    return this.#sim.snapshot();
  }

  async close(): Promise<void> {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.close(1000, "bye");
    await Promise.race([this.closed, sleep(3000)]);
  }

  #creditNow(): number {
    return this.#credit + (performance.now() - this.#creditAt);
  }

  #setCredit(ms: number): void {
    this.#credit = ms;
    this.#creditAt = performance.now();
  }
}
