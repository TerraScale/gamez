/**
 * The InstanceDO's logic for client-driven (verified) modes such as classic
 * (docs/design/wave-B.md §2.3-§2.4), without Workers APIs. The browser runs
 * the sim and streams input segments with its state hash; this host replays
 * each segment on its own copy (packages/kernel/src/replay.ts), persists the
 * verified ones, and answers anything else with a resync to the last verified
 * state. A wall-time credit ledger bounds sim time by real time (anti
 * speed-hack), offline progress is granted from server-measured absence, and
 * verified state is reported to the read model through the outbox.
 *
 * Durable state = base snapshot at tick B + the verified segment log (B, T].
 * The "verified" ack goes out only after the segment row committed.
 *
 * Messages are handled strictly one at a time through a promise queue:
 * packSnapshot is async (CompressionStream) and a DO does not block other
 * events during non-storage awaits.
 */
import {
  checkSegment,
  createSim,
  replaySegment,
  stableHash,
  type ClientDrivenPolicy,
  type LoadedMode,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import {
  BANK_ACTOR,
  jsonWithinLimits,
  MAX_IMPORT_SNAPSHOT_DEPTH,
  MAX_IMPORT_SNAPSHOT_NODES,
  packSnapshot,
  VAULT_MAX_ITEMS,
  VERIFIED_ACTOR,
  type ArenaBuild,
  type BankOp,
  type BankResult,
  type EconomyErrorCode,
  type OfflineGrant,
  type VaultItem,
  type ResyncCode,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
  type VerifyLimits,
} from "@gamez/protocol";
import type { ReportEnvelope } from "../contracts.ts";
import {
  actionCode,
  BANK_KEEP_MS,
  BANK_LIMIT,
  balanceOf,
  bankEventOf,
  creditAccount,
  failure,
  refundToAccount,
  SEASON_KV,
  takeFromAccount,
  type BankAccount,
} from "./bank-saga.ts";
import type { BankEffect, BankOpRow, BankStore } from "./bank-store.ts";
import { TokenBucket, type BucketSpec } from "../rate-limit.ts";
import { PING_LIMIT, type InstanceSocket, type SocketInfo } from "./host.ts";
import { CLOSE_REPLACED } from "./messages.ts";
import { encodeVerifiedServerMessage, parseVerifiedClientMessage } from "./verified-messages.ts";
import {
  emptyCounters,
  type StoredSegment,
  type VerifiedRecord,
  type VerifiedStore,
} from "./verified-store.ts";

// ---- ledger and limits (wave-B.md §2.4) ------------------------------------

/** Most wall-time credit the ledger accrues (ms). */
export const CREDIT_CAP_MS = 15 * 60_000;
/** A segment may overdraw the credit by this much (clock jitter, batching). */
export const TOLERANCE_MS = 2_000;
/** Credit of a new game, an import or after an offline grant. */
export const START_CREDIT_MS = 3_000;
/** Unverified ticks a client may hold while disconnected (sent in limits). */
export const MAX_PENDING_TICKS = 12_000;
/** The client cuts a segment at least this often while ticking (sent in limits). */
export const SEGMENT_EVERY_MS = 2_000;
/** Compaction: write a new base after this many verified ticks… */
export const COMPACT_TICKS = 1200;
/** …or this much wall time since the last base. */
export const COMPACT_MS = 30_000;
/** Carry-over / import validation run (ticks a clone must survive). */
export const VALIDATE_TICKS = 20;
/** Mismatches within FLAG_WINDOW_MS that flag the instance. */
export const FLAG_AFTER = 5;
export const FLAG_WINDOW_MS = 3_600_000;

/** Per-socket segment limit: a reconnect flush of 30 segments fits the burst. */
export const SEGMENT_LIMIT: BucketSpec = { burst: 40, perSecond: 2 };
/** Imports: one per minute per socket. */
export const IMPORT_LIMIT: BucketSpec = { burst: 1, perSecond: 1 / 60 };
/** Joins (each one packs a snapshot and bumps the epoch). */
export const JOIN_LIMIT: BucketSpec = { burst: 5, perSecond: 0.5 };

/** Actor of server-made dispatches (offline progress). */
export const SERVER_ACTOR = "server";

/** Where report rows go (the DO's Outbox, sharing the store's SQLite). */
export interface ReportOutbox {
  append(table: string, pk: string, op: "upsert" | "delete", payload: unknown): unknown;
}

/**
 * Wave C platform services of a verified instance (docs/design/wave-C.md
 * §2.4, §2.7-§2.8): the bank saga's store and account calls, the feature
 * flag, season reporting. Absent: the bank answers "unavailable".
 */
export interface VerifiedPlatformDeps {
  /** bank_op rows + platform_kv on the same SQLite as the VerifiedStore. */
  store: BankStore;
  account: BankAccount;
  /** Feature flag "bank" (config/flags.ts featureEnabled; fail open). */
  bankEnabled(): Promise<boolean>;
  /** Items in the account vault (pre-check for vault_full on item deposits). Optional. */
  vaultCount?(accountId: string): Promise<number>;
  /** AccountDO.seasonProgress (monotonic; retried at the next compaction on failure). */
  seasonProgress?(accountId: string, key: string, total: number): Promise<unknown>;
  /** A bank op is pending (account error, crash): call redrive() soon (DO: alarm). */
  scheduleRedrive(): void;
}

type BankMessage = Extract<VerifiedClientMessage, { t: "bank" }>;
type BankApplied = Extract<VerifiedServerMessage, { t: "bank" }>["applied"];
interface BankOutcome {
  result: BankResult;
  /** The verified sim changed (and was committed). */
  changed: boolean;
  payload: unknown;
}

const WITHDRAWALS: ReadonlySet<BankOp["kind"]> = new Set(["withdrawCoin", "withdrawItem"]);

/**
 * ADR 0007 R1: an imported hero (a client-authored local save) is quarantined
 * from everything shared across players: bank, arena, season progress, ranked
 * leaderboards. Only a new game clears the flag.
 */
export const IMPORTED_BANK_MESSAGE =
  "This hero was imported from a local save and can't use the bank. Start a new hero to trade.";

/** "<mode>:<accountId>" -> accountId. */
export function accountOfInstance(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : "";
}

export interface VerifiedHostDeps {
  /** DO name ("<mode>:<accountId>"); prefix of instance ids and report pks. */
  name: string;
  loaded: LoadedMode;
  /** loaded.mode.instance.clientDriven. */
  policy: ClientDrivenPolicy;
  store: VerifiedStore;
  /** Open sockets of this instance. */
  sockets(): InstanceSocket[];
  now(): number;
  /** Seed for a new game (crypto random in the DO). */
  randomSeed(): number;
  /** Report rows are appended here in the same transaction as the base; null = no reports. */
  outbox: ReportOutbox | null;
  /** Called after report rows were appended (DO: outbox.scheduleFlush). */
  scheduleFlush(): void;
  /** Diagnostics (default console). */
  log?(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  /** Wave C: bank, builds, season progress (null/absent: no platform). */
  platform?: VerifiedPlatformDeps | null;
}

interface Limits {
  segment: TokenBucket;
  import: TokenBucket;
  join: TokenBucket;
  ping: TokenBucket;
  bank: TokenBucket;
}

type LoadResult = "ok" | "new" | "carried" | "reset";

type Segment = Extract<VerifiedClientMessage, { t: "segment" }>;

export class VerifiedHost {
  readonly #d: VerifiedHostDeps;
  readonly #serverOnly: ReadonlySet<string>;
  readonly #msPerTick: number;
  #rec: VerifiedRecord | null = null;
  /**
   * Verified states the current sim descends from since the base: tick ->
   * hash (base and every logged segment end). A resume at one of them is a
   * client that missed acks (they were lost with the socket): it continues,
   * and its resubmitted segments are re-acked as duplicates.
   */
  #ancestors = new Map<number, string>();
  /** The sim at rec.verifiedTick (null until loaded). */
  #sim: Sim | null = null;
  #queue: Promise<void> = Promise.resolve();
  readonly #limits = new WeakMap<InstanceSocket, Limits>();
  /** A season report is in flight (one at a time; the next compaction retries). */
  #seasonInFlight = false;

  constructor(deps: VerifiedHostDeps) {
    const tick = deps.loaded.mode.tick;
    if (tick.kind !== "fixed") throw new Error("VerifiedHost: client-driven modes are fixed-tick");
    this.#d = deps;
    this.#serverOnly = new Set(deps.policy.serverOnlyActions);
    this.#msPerTick = 1000 / tick.hz;
  }

  get mode(): string {
    return this.#d.loaded.mode.id;
  }

  /** The sim at the verified tick, if loaded (tests). */
  get sim(): Sim | null {
    return this.#sim;
  }

  /** In-memory record (tests). */
  get record(): Readonly<VerifiedRecord> | null {
    return this.#rec;
  }

  /** Limits sent to clients in vstate. */
  get limits(): VerifyLimits {
    return {
      maxTicksPerSegment: this.#d.policy.maxTicksPerSegment,
      maxInputsPerSegment: this.#d.policy.maxInputsPerSegment,
      segmentEveryMs: SEGMENT_EVERY_MS,
      maxPendingTicks: MAX_PENDING_TICKS,
      creditCapMs: CREDIT_CAP_MS,
    };
  }

  /** Queues one client frame; the promise settles when it was handled (never rejects). */
  handleMessage(socket: InstanceSocket, frame: string | ArrayBuffer): Promise<void> {
    return this.#enqueue(() => this.#handle(socket, frame));
  }

  /** A socket closed: the last joined one marks the player inactive and compacts. */
  handleClose(socket: InstanceSocket): Promise<void> {
    return this.#enqueue(async () => {
      if (!socket.info.joined) return;
      if (this.#joined().some((s) => s !== socket)) return;
      if (!this.#rec || !this.#sim) return;
      this.#rec.lastActiveAt = this.#d.now();
      if (this.#rec.verifiedTick > this.#rec.baseTick) this.#compact();
      else this.#d.store.saveMeta(this.#rec);
    });
  }

  /** Like #enqueue, for work that returns a value (fallback when it throws). */
  #enqueueValue<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    let out = fallback;
    return this.#enqueue(async () => {
      out = await fn();
    }).then(() => out);
  }

  #enqueue(fn: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        this.#log("error", `verified ${this.#d.name}: handler failed`, err);
        this.#forget();
      }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p;
    return p;
  }

  async #handle(socket: InstanceSocket, frame: string | ArrayBuffer): Promise<void> {
    const msg = parseVerifiedClientMessage(frame);
    if (!msg) {
      this.#send(socket, { t: "error", code: "bad_message", message: "invalid message" });
      return;
    }
    const now = this.#d.now();
    try {
      switch (msg.t) {
        case "ping":
          if (!this.#limitsOf(socket).ping.take(now)) return;
          this.#send(socket, { t: "pong", clientTime: msg.clientTime, serverTime: now });
          return;
        case "join":
          if (!this.#limitsOf(socket).join.take(now)) {
            this.#send(socket, { t: "error", code: "rate_limited", message: "too many joins" });
            return;
          }
          await this.#join(socket, msg);
          return;
        case "segment":
          await this.#segment(socket, msg);
          return;
        case "import":
          await this.#import(socket, msg);
          return;
        case "bank":
          await this.#bank(socket, msg);
          return;
      }
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: ${msg.t} failed`, err);
      // Memory may be ahead of storage now: the next message reloads durable state.
      this.#forget();
      this.#send(socket, { t: "error", code: "internal", message: `${msg.t} failed` });
    }
  }

  // ---- join ----------------------------------------------------------------

  async #join(socket: InstanceSocket, msg: Extract<VerifiedClientMessage, { t: "join" }>) {
    const info = socket.info;
    if (msg.mode !== info.mode || msg.mode !== this.mode) {
      this.#send(socket, {
        t: "error",
        code: "wrong_mode",
        message: `this connection is for mode "${info.mode}"`,
      });
      return;
    }
    // One live socket per player: the newest wins.
    for (const other of this.#d.sockets()) {
      if (other !== socket && other.info.joined) {
        other.setInfo({ ...other.info, joined: false });
        try {
          other.close(CLOSE_REPLACED, "replaced by a newer connection");
        } catch {
          // Already gone.
        }
      }
    }
    if (!info.joined) socket.setInfo({ ...info, joined: true });

    const now = this.#d.now();
    const fresh = msg.fresh === true;
    let loadResult: LoadResult = "new";
    if (fresh) {
      this.#newGame(this.#rec ?? this.#d.store.load());
      this.#rec!.accountId = info.accountId;
      this.#rec!.displayName = info.name;
    } else {
      loadResult = this.#ensure(info);
    }
    const rec = this.#rec!;
    const sim = this.#sim!;
    rec.accountId = info.accountId;
    rec.displayName = info.name;
    if (loadResult === "reset") {
      this.#send(socket, {
        t: "error",
        code: "content_changed",
        message: "the game was updated; your previous hero could not be carried over",
      });
    }

    // Offline progress from server-measured absence (never when the client holds unsent play).
    let grant: OfflineGrant | null = null;
    const offline = this.#d.policy.offline;
    if (!fresh && loadResult === "ok" && offline && msg.resume?.pending !== true) {
      const elapsed = now - rec.lastActiveAt;
      if (elapsed >= offline.minMs && this.#safe(() => offline.eligible(sim.world), false)) {
        const elapsedMs = Math.min(elapsed, offline.capMs);
        const res = sim.dispatch(offline.action, { elapsedMs }, SERVER_ACTOR);
        if (res.ok) grant = { elapsedMs, events: res.events };
        else this.#log("info", `verified ${this.#d.name}: offline grant refused`, res.error);
      }
    }

    const resume = msg.resume;
    const continued =
      !fresh &&
      loadResult === "ok" &&
      grant === null &&
      resume !== undefined &&
      this.#ancestors.get(resume.tick) === resume.hash;

    rec.epoch++;
    if (grant || fresh || loadResult !== "ok") {
      // No double dip: offline progress and new games start the ledger over.
      rec.creditMs = START_CREDIT_MS;
      rec.creditAt = now;
      rec.lastActiveAt = now;
    } else {
      this.#accrue(now);
    }
    if (grant || fresh) {
      // Server-made changes and new games become the base right away.
      rec.verifiedTick = sim.tick;
      rec.verifiedHash = sim.hash();
      this.#compact();
    } else {
      // #ensure already wrote a base for new / carried / reset instances.
      this.#d.store.saveMeta(rec);
    }

    const snapshot = continued ? null : await packSnapshot(sim.snapshot());
    this.#send(socket, {
      t: "vstate",
      instanceId: rec.instanceId,
      mode: this.mode,
      contentHash: this.#d.loaded.contentHash,
      epoch: rec.epoch,
      tick: rec.verifiedTick,
      hash: rec.verifiedHash,
      continued,
      snapshot,
      offline: grant,
      imported: rec.imported,
      importable: this.#importable(rec),
      serverTime: this.#d.now(),
      limits: this.limits,
    });
  }

  // ---- segments --------------------------------------------------------------

  async #segment(socket: InstanceSocket, msg: Segment): Promise<void> {
    if (!socket.info.joined) {
      this.#send(socket, { t: "error", code: "not_joined", message: "join first" });
      return;
    }
    const now = this.#d.now();
    if (!this.#limitsOf(socket).segment.take(now)) {
      this.#send(socket, { t: "error", code: "rate_limited", message: "too many segments" });
      return;
    }
    const loadResult = this.#ensure(socket.info);
    const rec = this.#rec!;
    if (loadResult !== "ok") {
      await this.#resync(socket, msg.seq, "content_changed", "the game was updated", now);
      return;
    }
    if (msg.epoch !== rec.epoch) return; // In flight when the last vstate/resync went out.
    if (msg.toTick <= rec.verifiedTick) {
      // Duplicate (a resend after a lost ack): everything up to verifiedTick is durable.
      this.#accrue(now);
      this.#sendVerified(socket, msg.seq);
      return;
    }
    if (msg.fromTick !== rec.verifiedTick) {
      await this.#resync(
        socket,
        msg.seq,
        "gap",
        `segment starts at ${msg.fromTick}, verified tick is ${rec.verifiedTick}`,
        now,
      );
      return;
    }

    const policy = this.#d.policy;
    const limits = {
      maxTicks: policy.maxTicksPerSegment,
      maxInputs: policy.maxInputsPerSegment,
      serverOnly: this.#serverOnly,
    };
    const shape = checkSegment(msg, rec.verifiedTick, limits);
    if (shape) {
      await this.#resync(socket, msg.seq, shape.code, shape.message, now);
      return;
    }
    this.#accrue(now);
    // Cheapest possible cost: every tick at max speed. Over budget even then: no replay.
    const span = msg.toTick - msg.fromTick;
    const minCost = (span * this.#msPerTick) / Math.max(1, policy.maxSpeed);
    if (rec.creditMs - minCost < -TOLERANCE_MS) {
      await this.#resync(socket, msg.seq, "too_fast", this.#tooFastMessage(minCost), now);
      return;
    }

    const sim = this.#sim!;
    const out = replaySegment(sim, msg, {
      actor: VERIFIED_ACTOR,
      ...limits,
      speedOf: (w) => policy.speedOf(w),
      maxSpeed: policy.maxSpeed,
      expectHash: msg.hash,
    });
    if (!out.ok) {
      // The server did the work: a failed replay costs credit like a good one.
      rec.creditMs -= out.costMs;
      this.#restoreSim();
      await this.#resync(socket, msg.seq, out.code, out.message, now);
      return;
    }
    if (rec.creditMs - out.costMs < -TOLERANCE_MS) {
      this.#restoreSim();
      await this.#resync(socket, msg.seq, "too_fast", this.#tooFastMessage(out.costMs), now);
      return;
    }

    const prev = {
      tick: rec.verifiedTick,
      hash: rec.verifiedHash,
      credit: rec.creditMs,
      lastActiveAt: rec.lastActiveAt,
    };
    rec.creditMs -= out.costMs;
    rec.verifiedTick = msg.toTick;
    rec.verifiedHash = out.hash;
    rec.lastActiveAt = now;
    rec.segmentsTotal++;
    const stored: StoredSegment = {
      fromTick: msg.fromTick,
      toTick: msg.toTick,
      inputs: msg.inputs,
      hash: out.hash,
    };
    try {
      this.#d.store.appendSegment(stored, rec);
      this.#ancestors.set(rec.verifiedTick, rec.verifiedHash);
    } catch (err) {
      // Memory is ahead of storage: roll the bookkeeping back and restore the sim.
      this.#log("error", `verified ${this.#d.name}: segment not persisted`, err);
      rec.verifiedTick = prev.tick;
      rec.verifiedHash = prev.hash;
      rec.creditMs = prev.credit;
      rec.lastActiveAt = prev.lastActiveAt;
      rec.segmentsTotal--;
      this.#restoreSim();
      await this.#resync(socket, msg.seq, "internal", "the segment could not be saved", now, false);
      return;
    }
    this.#sendVerified(socket, msg.seq);
    if (rec.verifiedTick - rec.baseTick >= COMPACT_TICKS || now - rec.baseAt >= COMPACT_MS) {
      try {
        this.#compact();
      } catch (err) {
        // The log is still durable; compaction retries on the next segment.
        this.#log("error", `verified ${this.#d.name}: compaction failed`, err);
      }
    }
  }

  #tooFastMessage(cost: number): string {
    const credit = Math.round(this.#rec?.creditMs ?? 0);
    return `segment needs ${Math.round(cost)} ms of play time, ${credit} ms available`;
  }

  #sendVerified(socket: InstanceSocket, seq: number): void {
    const rec = this.#rec!;
    this.#send(socket, {
      t: "verified",
      epoch: rec.epoch,
      seq,
      tick: rec.verifiedTick,
      hash: rec.verifiedHash,
      creditMs: Math.round(rec.creditMs),
    });
  }

  /** New epoch + the verified snapshot; counts the mismatch. The sim must be at the verified state. */
  async #resync(
    socket: InstanceSocket,
    seq: number,
    code: ResyncCode,
    message: string,
    now: number,
    count = true,
  ): Promise<void> {
    const rec = this.#rec!;
    rec.epoch++;
    if (count) this.#countMismatch(code, now);
    try {
      this.#d.store.saveMeta(rec);
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: could not save the epoch`, err);
    }
    this.#send(socket, {
      t: "resync",
      epoch: rec.epoch,
      seq,
      code,
      message,
      tick: rec.verifiedTick,
      hash: rec.verifiedHash,
      snapshot: await packSnapshot(this.#sim!.snapshot()),
    });
  }

  #countMismatch(code: ResyncCode, now: number): void {
    const c = this.#rec!.counters;
    c.byCode[code] = (c.byCode[code] ?? 0) + 1;
    c.recent = c.recent.filter((t) => now - t < FLAG_WINDOW_MS).slice(-(FLAG_AFTER * 4));
    c.recent.push(now);
    if (!c.flagged && c.recent.length >= FLAG_AFTER) {
      c.flagged = true;
      this.#log("warn", `verified ${this.#d.name}: flagged after ${c.recent.length} mismatches`, {
        byCode: c.byCode,
      });
    }
  }

  // ---- bank (wave C, docs/design/wave-C.md §2.4) ------------------------------

  async #bank(socket: InstanceSocket, msg: BankMessage): Promise<void> {
    const answer = (result: BankResult, applied: BankApplied = null): void =>
      this.#send(socket, { t: "bank", opId: msg.opId, result, applied });
    const fail = (code: EconomyErrorCode, message: string): void => answer(failure(code, message));
    if (!socket.info.joined) return fail("unavailable", "join first");
    const now = this.#d.now();
    if (!this.#limitsOf(socket).bank.take(now)) {
      return fail("rate_limited", "too many bank operations, wait a moment");
    }
    const p = this.#d.platform;
    const hooks = this.#d.policy.platform;
    if (!p || !hooks) return fail("unavailable", "this mode has no bank");
    if (!(await this.#bankEnabled(p))) return fail("disabled", "the bank is closed right now");
    if (this.#ensure(socket.info) !== "ok") {
      await this.#resync(socket, 0, "content_changed", "the game was updated", now);
      return fail("unavailable", "the game was updated, try again");
    }
    const rec = this.#rec!;
    // ADR 0007 R1: before any bank row or account call, deposits and withdrawals alike.
    if (rec.imported) {
      this.#log("info", `verified ${this.#d.name}: bank refused for an imported hero`, {
        opId: msg.opId,
        kind: msg.op.kind,
        imported: true,
      });
      return fail("not_eligible", IMPORTED_BANK_MESSAGE);
    }
    const fast = msg.at.tick === rec.verifiedTick && msg.at.hash === rec.verifiedHash;
    const accountId = socket.info.accountId;

    const prior = p.store.get(msg.opId);
    if (prior) {
      if (prior.accountId !== accountId || stableHash(prior.op) !== stableHash(msg.op)) {
        return fail("conflict", "this operation id was already used for something else");
      }
      if (prior.state !== "done") await this.#redriveOp(p, prior);
      const row = p.store.get(msg.opId);
      // The client may lack the change (its first answer was lost): send the verified state.
      if (!fast && (this.#sim !== null || this.#ensure(socket.info) === "ok")) {
        await this.#resync(socket, 0, "bank", "bank operation already applied", now, false);
      }
      return answer(row?.result ?? failure("unavailable", "the operation is still pending"));
    }
    try {
      p.store.prune(now - BANK_KEEP_MS);
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: bank prune failed`, err);
    }

    const out = WITHDRAWALS.has(msg.op.kind)
      ? await this.#bankWithdraw(p, hooks.bankAction, accountId, msg, now)
      : await this.#bankDeposit(p, hooks, accountId, msg, now);
    if (out.changed && this.#rec && this.#sim) {
      if (fast) {
        const r = this.#rec;
        return answer(out.result, {
          tick: r.verifiedTick,
          name: hooks.bankAction,
          payload: out.payload,
          hash: r.verifiedHash,
        });
      }
      await this.#resync(socket, 0, "bank", "a bank operation changed your hero", now, false);
    }
    answer(out.result);
  }

  async #bankEnabled(p: VerifiedPlatformDeps): Promise<boolean> {
    try {
      return await p.bankEnabled();
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: bank flag unreadable, open`, err);
      return true;
    }
  }

  /** Withdrawals take from the account first, then dispatch; a failed dispatch refunds. */
  async #bankWithdraw(
    p: VerifiedPlatformDeps,
    action: string,
    accountId: string,
    msg: BankMessage,
    now: number,
  ): Promise<BankOutcome> {
    const none = (result: BankResult): BankOutcome => ({ result, changed: false, payload: null });
    const row: BankOpRow = {
      opId: msg.opId,
      accountId,
      state: "taking",
      op: msg.op,
      effect: null,
      result: null,
      at: now,
    };
    p.store.put(row);
    let taken: Awaited<ReturnType<typeof takeFromAccount>>;
    try {
      taken = await takeFromAccount(p.account, this.#d.name, this.mode, row);
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: bank take failed`, err);
      p.scheduleRedrive();
      return none(failure("unavailable", "the account did not answer, try again"));
    }
    if (!taken.ok) {
      this.#finishOp(p, row, taken.result);
      return none(taken.result);
    }
    const effect: BankEffect = taken.effect;
    if (effect.balance === null) effect.balance = await balanceOf(p.account, accountId);
    row.state = "applied";
    row.effect = effect;
    p.store.put(row);

    const payload: Record<string, unknown> = { opId: msg.opId, op: msg.op };
    if (effect.item !== null) payload.item = effect.item;
    const sim = this.#sim!;
    const res = sim.dispatch(action, payload, BANK_ACTOR);
    if (!res.ok) {
      const result = failure(actionCode(res.error?.code), res.error?.message ?? "refused");
      await this.#refundOp(p, row, result);
      return none(result);
    }
    const result: BankResult = { ok: true, balance: effect.balance ?? 0 };
    if (msg.op.kind === "withdrawCoin") {
      result.coin = effect.coin;
      result.gold = effect.coin;
    } else if (effect.item !== null) {
      result.item = effect.item as VaultItem;
    }
    row.state = "done";
    row.result = result;
    try {
      this.#commitBank(() => p.store.put(row));
    } catch (err) {
      // Nothing was committed (the row is still "applied"): undo the take.
      this.#log("error", `verified ${this.#d.name}: bank commit failed`, err);
      this.#forget();
      row.state = "applied";
      row.result = null;
      const r = failure("internal", "the bank could not save, nothing was moved");
      await this.#refundOp(p, row, r);
      return none(r);
    }
    return { result, changed: true, payload };
  }

  /** Deposits dispatch first, commit the sim with the op row, then credit the account. */
  async #bankDeposit(
    p: VerifiedPlatformDeps,
    hooks: NonNullable<ClientDrivenPolicy["platform"]>,
    accountId: string,
    msg: BankMessage,
    now: number,
  ): Promise<BankOutcome> {
    const none = (result: BankResult): BankOutcome => ({ result, changed: false, payload: null });
    if (msg.op.kind === "depositItem" && p.vaultCount) {
      try {
        if ((await p.vaultCount(accountId)) >= VAULT_MAX_ITEMS) {
          return none(failure("vault_full", "the vault is full"));
        }
      } catch (err) {
        this.#log("warn", `verified ${this.#d.name}: vault size unknown`, err);
      }
    }
    const payload = { opId: msg.opId, op: msg.op };
    const sim = this.#sim!;
    const res = sim.dispatch(hooks.bankAction, payload, BANK_ACTOR);
    if (!res.ok) {
      return none(failure(actionCode(res.error?.code), res.error?.message ?? "refused"));
    }
    const ev = bankEventOf(res.events, hooks.bankEvent);
    if (!ev || (ev.credit === null && ev.item === null)) {
      this.#log("error", `verified ${this.#d.name}: bank action without an effect`, res.events);
      this.#restoreSim();
      return none(failure("internal", "the bank made a mistake, nothing was moved"));
    }
    const row: BankOpRow = {
      opId: msg.opId,
      accountId,
      state: "crediting",
      op: msg.op,
      effect: { coin: ev.credit?.coin ?? 0, gold: Math.abs(ev.gold), item: ev.item, balance: null },
      result: null,
      at: now,
    };
    try {
      this.#commitBank(() => p.store.put(row));
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: bank commit failed`, err);
      this.#forget();
      return none(failure("internal", "the bank could not save, nothing was moved"));
    }
    return { result: await this.#creditOp(p, row), changed: true, payload };
  }

  /** The bank changed the sim at the verified tick: it becomes the new base (log restarts there). */
  #commitBank(extra: () => void): void {
    const rec = this.#rec!;
    rec.verifiedTick = this.#sim!.tick;
    rec.verifiedHash = this.#sim!.hash();
    this.#compact(extra);
  }

  #finishOp(p: VerifiedPlatformDeps, row: BankOpRow, result: BankResult): void {
    row.state = "done";
    row.result = result;
    try {
      p.store.put(row);
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: bank row not saved`, err);
    }
  }

  /** Credits a committed deposit; a provisional ok result while the account is unreachable. */
  async #creditOp(p: VerifiedPlatformDeps, row: BankOpRow): Promise<BankResult> {
    try {
      const r = await creditAccount(p.account, this.#d.name, this.mode, row, this.#sagaLog);
      if (r) {
        this.#finishOp(p, row, r);
        return r;
      }
      this.#log("warn", `verified ${this.#d.name}: credit of ${row.opId} refused, retrying later`);
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: credit of ${row.opId} failed`, err);
    }
    p.scheduleRedrive();
    // The hero's side is done; the account side follows on the next re-drive.
    const e = row.effect!;
    const result: BankResult = { ok: true, balance: await balanceOf(p.account, row.accountId) };
    if (e.coin > 0) result.coin = e.coin;
    if (e.gold > 0) result.gold = e.gold;
    return result;
  }

  /** Gives a withdrawal's take back and finishes the op with `result`. */
  async #refundOp(p: VerifiedPlatformDeps, row: BankOpRow, result: BankResult): Promise<void> {
    row.state = "refunding";
    row.result = result;
    p.store.put(row);
    try {
      await refundToAccount(p.account, this.#d.name, this.mode, row, this.#sagaLog);
      this.#finishOp(p, row, result);
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: refund of ${row.opId} failed`, err);
      p.scheduleRedrive();
    }
  }

  /** Continues one pending op (crash, account error). Every account call is idempotent by txId. */
  async #redriveOp(p: VerifiedPlatformDeps, row: BankOpRow): Promise<void> {
    const interrupted = failure("unavailable", "the operation was interrupted and undone");
    switch (row.state) {
      case "taking": {
        // Did the take happen? Replaying it (same txId) tells, or takes now; either way undo it.
        let taken: Awaited<ReturnType<typeof takeFromAccount>>;
        try {
          taken = await takeFromAccount(p.account, this.#d.name, this.mode, row, true);
        } catch (err) {
          this.#log("warn", `verified ${this.#d.name}: re-take of ${row.opId} failed`, err);
          p.scheduleRedrive();
          return;
        }
        if (!taken.ok) {
          // Nothing was taken. A reused opId (conflict) says so; anything else was undone.
          const r = taken.result;
          this.#finishOp(p, row, !r.ok && r.code === "conflict" ? r : interrupted);
          return;
        }
        row.effect = taken.effect;
        await this.#refundOp(p, row, interrupted);
        return;
      }
      case "applied":
        // Taken but never committed (the commit writes "done" with the new base).
        await this.#refundOp(p, row, interrupted);
        return;
      case "refunding":
        await this.#refundOp(p, row, row.result ?? interrupted);
        return;
      case "crediting":
        await this.#creditOp(p, row);
        return;
      case "done":
        return;
    }
  }

  /**
   * Re-drives every pending bank op (the DO alarm; also on wake). Resolves
   * with the number of ops still pending afterwards.
   */
  redrive(): Promise<number> {
    return this.#enqueueValue(async () => {
      const p = this.#d.platform;
      if (!p) return 0;
      for (const row of p.store.pending()) await this.#redriveOp(p, row);
      return p.store.pending().length;
    }, 0);
  }

  /** Pending bank ops right now (DO: keep the alarm while > 0). */
  pendingBankOps(): number {
    try {
      return this.#d.platform?.store.pending().length ?? 0;
    } catch {
      return 0;
    }
  }

  /** Cold load: a pending bank op from before the restart is re-driven soon. */
  #wakePending(): void {
    const p = this.#d.platform;
    if (p && this.pendingBankOps() > 0) p.scheduleRedrive();
  }

  // ---- arena builds and season progress (wave-C.md §2.7, §2.8) ------------------

  /**
   * The verified hero as an arena build (policy.platform.build of the verified
   * sim + accountId from the instance name, displayName and sourceHash), or
   * null: no build hook, nothing stored yet, no hero.
   */
  exportBuild(displayName: string): Promise<ArenaBuild | null> {
    return this.#enqueueValue(async () => {
      const hooks = this.#d.policy.platform;
      if (!hooks?.build) return null;
      if (!this.#sim && !this.#d.store.load()) return null;
      this.#ensure();
      const sim = this.#sim;
      if (!sim) return null;
      // ADR 0007 R1: an imported hero never fights in the arena.
      if (this.#rec?.imported) return null;
      const b = this.#safe(() => hooks.build?.(sim.world, this.#d.loaded.registry) ?? null, null);
      if (!b) return null;
      return {
        ...b,
        accountId: accountOfInstance(this.#d.name),
        displayName,
        sourceHash: sim.hash(),
      } as unknown as ArenaBuild;
    }, null);
  }

  /** After a compaction: report a changed season total (fire-and-forget, monotonic). */
  #reportSeason(sim: Sim): void {
    const p = this.#d.platform;
    const hooks = this.#d.policy.platform;
    if (!p?.seasonProgress || !hooks?.seasonTotal || this.#seasonInFlight) return;
    // ADR 0007 R1: an imported hero earns no season progress.
    if (this.#rec?.imported) return;
    const accountId = this.#rec?.accountId || accountOfInstance(this.#d.name);
    if (!accountId) return;
    const s = this.#safe(
      () => hooks.seasonTotal?.(sim.world, this.#d.loaded.registry) ?? null,
      null,
    );
    if (!s || !Number.isSafeInteger(s.total) || s.total <= 0) return;
    const value = JSON.stringify({ key: s.key, total: s.total });
    let last: string | null;
    try {
      last = p.store.kvGet(SEASON_KV);
    } catch {
      return;
    }
    if (last === value) return;
    this.#seasonInFlight = true;
    let sent: Promise<unknown>;
    try {
      sent = Promise.resolve(p.seasonProgress(accountId, s.key, s.total));
    } catch (err) {
      sent = Promise.reject(err);
    }
    void sent
      .then(
        () => {
          try {
            p.store.kvSet(SEASON_KV, value);
          } catch (err) {
            this.#log("warn", `verified ${this.#d.name}: season report not saved`, err);
          }
        },
        (err: unknown) => {
          this.#log("warn", `verified ${this.#d.name}: season report failed`, err);
        },
      )
      .finally(() => {
        this.#seasonInFlight = false;
      });
  }

  // ---- import ----------------------------------------------------------------

  async #import(socket: InstanceSocket, msg: Extract<VerifiedClientMessage, { t: "import" }>) {
    if (!socket.info.joined) {
      this.#send(socket, { t: "error", code: "not_joined", message: "join first" });
      return;
    }
    const now = this.#d.now();
    if (!this.#limitsOf(socket).import.take(now)) {
      this.#send(socket, { t: "error", code: "rate_limited", message: "one import per minute" });
      return;
    }
    this.#ensure(socket.info);
    const rec = this.#rec!;
    if (!this.#importable(rec)) {
      this.#send(socket, {
        t: "error",
        code: "not_importable",
        message: "this hero already has server progress",
      });
      return;
    }
    if (this.#bankBusy()) {
      this.#sendBankBusy(socket);
      return;
    }
    // R8: the server never inflates client data (workerd's DecompressionStream
    // does not bound memory), and the save's structure is bounded before any
    // restore or clone. The frame itself is capped at MAX_VERIFIED_CLIENT_FRAME.
    if (msg.snapshot.enc !== "json") {
      this.#send(socket, {
        t: "error",
        code: "import_rejected",
        message: "compressed saves are not accepted",
      });
      return;
    }
    const snap: SimSnapshot = msg.snapshot.data;
    if (!jsonWithinLimits(snap, MAX_IMPORT_SNAPSHOT_NODES, MAX_IMPORT_SNAPSHOT_DEPTH)) {
      this.#send(socket, { t: "error", code: "import_rejected", message: "the save is too large" });
      return;
    }
    const { loaded } = this.#d;
    if (
      typeof snap !== "object" ||
      snap === null ||
      snap.modeId !== loaded.mode.id ||
      snap.contentHash !== loaded.contentHash
    ) {
      this.#send(socket, {
        t: "error",
        code: "import_rejected",
        message: "the save belongs to another game version",
      });
      return;
    }
    const sim = this.#validated(snap, rec.seed);
    if (!sim) {
      this.#send(socket, {
        t: "error",
        code: "import_rejected",
        message: "the save does not run on this version",
      });
      return;
    }
    // Re-check after the await: another message cannot have run (queue), but stay strict.
    if (!this.#importable(rec)) return;
    if (this.#bankBusy()) {
      this.#sendBankBusy(socket);
      return;
    }
    this.#sim = sim;
    rec.epoch++;
    rec.verifiedTick = sim.tick;
    rec.verifiedHash = sim.hash();
    rec.imported = true;
    rec.importUsed = true;
    rec.creditMs = START_CREDIT_MS;
    rec.creditAt = now;
    rec.lastActiveAt = now;
    this.#compact();
    this.#send(socket, {
      t: "vstate",
      instanceId: rec.instanceId,
      mode: this.mode,
      contentHash: loaded.contentHash,
      epoch: rec.epoch,
      tick: rec.verifiedTick,
      hash: rec.verifiedHash,
      continued: false,
      snapshot: await packSnapshot(sim.snapshot()),
      offline: null,
      imported: true,
      importable: false,
      serverTime: this.#d.now(),
      limits: this.limits,
    });
  }

  #importable(rec: VerifiedRecord): boolean {
    return rec.segmentsTotal === 0 && !rec.importUsed;
  }

  /**
   * A bank op is still pending (ADR 0007 R1): an import now could land a
   * half-finished withdrawal on the imported sim. Fails closed when the bank
   * store is unreadable.
   */
  #bankBusy(): boolean {
    const p = this.#d.platform;
    if (!p) return false;
    try {
      return p.store.pending().length > 0;
    } catch (err) {
      this.#log("warn", `verified ${this.#d.name}: bank ops unreadable, import refused`, err);
      return true;
    }
  }

  #sendBankBusy(socket: InstanceSocket): void {
    this.#send(socket, {
      t: "error",
      code: "not_importable",
      message: "finish the pending bank operation first",
    });
  }

  /** A sim restored from `snap` whose clone survives VALIDATE_TICKS ticks; null otherwise. */
  #validated(snap: SimSnapshot, seed: number): Sim | null {
    try {
      const sim = createSim(this.#d.loaded, { seed, from: snap });
      const clone = createSim(this.#d.loaded, { seed, from: sim.snapshot() });
      clone.step(VALIDATE_TICKS);
      return sim;
    } catch {
      return null;
    }
  }

  // ---- state lifecycle --------------------------------------------------------

  /**
   * Loads the instance into memory if needed: "ok" (cached or restored),
   * "new" (nothing stored: a new game), "carried" (content changed, carried
   * over under the new contentHash, log dropped), "reset" (stored state
   * unusable: a new game).
   */
  #ensure(who?: SocketInfo): LoadResult {
    if (this.#rec && this.#sim) return "ok";
    const { loaded } = this.#d;
    const stored = this.#d.store.load();
    const owner = (rec: VerifiedRecord): void => {
      if (!who) return;
      rec.accountId = who.accountId;
      rec.displayName = who.name;
    };
    if (!stored) {
      this.#newGame(null);
      owner(this.#rec!);
      this.#compact();
      return "new";
    }
    owner(stored);
    this.#wakePending();
    if (stored.base.modeId === loaded.mode.id && stored.base.contentHash === loaded.contentHash) {
      this.#rec = stored;
      if (this.#restoreSim()) return "ok";
      this.#log("warn", `verified ${this.#d.name}: stored base unusable, starting over`);
    } else if (stored.base.modeId === loaded.mode.id && this.#carryable(stored.moduleIds)) {
      const sim = this.#carry(stored);
      if (sim) {
        this.#rec = stored;
        this.#sim = sim;
        stored.verifiedTick = sim.tick;
        stored.verifiedHash = sim.hash();
        this.#compact();
        this.#log("info", `verified ${this.#d.name}: carried over to ${loaded.contentHash}`);
        return "carried";
      }
    }
    this.#newGame(stored);
    owner(this.#rec!);
    this.#compact();
    return "reset";
  }

  /**
   * Content carry-over (the wave A local save rule, server side): the base
   * relabelled to the loaded contentHash must survive VALIDATE_TICKS ticks.
   * The stored log is then re-applied under the new content without hash
   * checks (its inputs were verified under the old content); if any of it
   * fails, the relabelled base alone is kept.
   */
  #carry(stored: VerifiedRecord): Sim | null {
    const { loaded, policy } = this.#d;
    const from: SimSnapshot = { ...stored.base, contentHash: loaded.contentHash };
    const base = this.#validated(from, stored.seed);
    if (!base) return null;
    const log = this.#d.store.segments();
    if (log.length === 0) return base;
    try {
      const sim = createSim(loaded, { seed: stored.seed, from: base.snapshot() });
      for (const seg of log) {
        const out = replaySegment(sim, seg, {
          actor: VERIFIED_ACTOR,
          maxTicks: Number.MAX_SAFE_INTEGER,
          maxInputs: Number.MAX_SAFE_INTEGER,
          speedOf: (w) => policy.speedOf(w),
          maxSpeed: policy.maxSpeed,
        });
        if (!out.ok) return base;
      }
      return sim;
    } catch {
      return base;
    }
  }

  /** Stored module ids are all still loaded (missing ones create their state lazily). */
  #carryable(stored: readonly string[]): boolean {
    if (stored.length === 0) return false;
    const current = new Set(this.#d.loaded.modules.map((m) => m.id));
    return stored.every((id) => current.has(id));
  }

  /**
   * Rebuilds the sim from durable state: the base plus the stored segment log.
   * A log that no longer replays (it verified before, so it should) is
   * dropped and the state falls back to the base. False when the base itself
   * cannot be restored.
   */
  #restoreSim(): boolean {
    const rec = this.#rec!;
    const { loaded, policy } = this.#d;
    let sim: Sim;
    try {
      sim = createSim(loaded, { seed: rec.seed, from: rec.base });
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: base does not restore`, err);
      this.#sim = null;
      return false;
    }
    const log = this.#d.store.segments();
    const ancestors = new Map([[sim.tick, sim.hash()]]);
    let ok = true;
    for (const seg of log) {
      const out = replaySegment(sim, seg, {
        actor: VERIFIED_ACTOR,
        maxTicks: Number.MAX_SAFE_INTEGER,
        maxInputs: Number.MAX_SAFE_INTEGER,
        speedOf: (w) => policy.speedOf(w),
        maxSpeed: policy.maxSpeed,
        expectHash: seg.hash,
      });
      if (!out.ok) {
        this.#log("error", `verified ${this.#d.name}: stored segment ${seg.toTick} failed`, out);
        ok = false;
        break;
      }
      ancestors.set(seg.toTick, seg.hash);
    }
    if (ok && (sim.tick !== rec.verifiedTick || sim.hash() !== rec.verifiedHash)) ok = false;
    if (!ok) {
      sim = createSim(loaded, { seed: rec.seed, from: rec.base });
      rec.verifiedTick = sim.tick;
      rec.verifiedHash = sim.hash();
      this.#sim = sim;
      this.#compact();
      return true;
    }
    this.#sim = sim;
    this.#ancestors = ancestors;
    // A long log makes the next rebuild expensive: start the next one from here.
    if (log.length > 0 && rec.verifiedTick - rec.baseTick >= COMPACT_TICKS / 2) this.#compact();
    return true;
  }

  /** Replaces memory with a new game (not yet written); lifetime fields carry over from `prior`. */
  #newGame(prior: VerifiedRecord | null): void {
    const now = this.#d.now();
    const seed = this.#d.randomSeed() >>> 0;
    const sim = createSim(this.#d.loaded, { seed });
    this.#sim = sim;
    this.#rec = {
      instanceId: `${this.#d.name}:${seed.toString(16).padStart(8, "0")}`,
      seed,
      epoch: prior?.epoch ?? 0,
      base: sim.snapshot(),
      baseTick: sim.tick,
      baseAt: now,
      verifiedTick: sim.tick,
      verifiedHash: sim.hash(),
      creditMs: START_CREDIT_MS,
      creditAt: now,
      lastActiveAt: now,
      imported: false,
      importUsed: prior?.importUsed ?? false,
      segmentsTotal: prior?.segmentsTotal ?? 0,
      moduleIds: this.#moduleIds(),
      accountId: prior?.accountId ?? "",
      displayName: prior?.displayName ?? "",
      counters: prior?.counters ?? emptyCounters(),
    };
  }

  #moduleIds(): string[] {
    return this.#d.loaded.modules.map((m) => m.id);
  }

  /** Credit grows with wall time, capped. */
  #accrue(now: number): void {
    const rec = this.#rec!;
    const dt = Math.max(0, now - rec.creditAt);
    rec.creditMs = Math.min(CREDIT_CAP_MS, rec.creditMs + dt);
    rec.creditAt = now;
  }

  /**
   * Writes the current verified state as the new base (dropping the log) and,
   * in the same transaction, the report rows that changed since last time.
   */
  #compact(extra?: () => void): void {
    const rec = this.#rec!;
    const sim = this.#sim!;
    rec.base = sim.snapshot();
    rec.baseTick = sim.tick;
    this.#ancestors = new Map([[rec.verifiedTick, rec.verifiedHash]]);
    rec.baseAt = this.#d.now();
    rec.moduleIds = this.#moduleIds();
    let appended = 0;
    this.#d.store.transaction(() => {
      this.#d.store.writeBase(rec);
      appended = this.#appendReports(sim);
      extra?.();
    });
    if (appended > 0) this.#d.scheduleFlush();
    this.#reportSeason(sim);
  }

  /** Appends changed report rows to the outbox (inside the caller's transaction). */
  #appendReports(sim: Sim): number {
    const { outbox, policy, store, loaded } = this.#d;
    if (!outbox || !policy.reports) return 0;
    const rows = this.#safe(() => policy.reports?.(sim.world, loaded.registry) ?? [], []);
    const rec = this.#rec!;
    let n = 0;
    for (const row of rows) {
      const hash = stableHash({
        data: row.data,
        displayName: rec.displayName,
        imported: rec.imported,
      });
      if (store.reportHash(row.table, row.key) === hash) continue;
      const envelope: ReportEnvelope = {
        accountId: rec.accountId,
        displayName: rec.displayName,
        mode: this.mode,
        imported: rec.imported,
        key: row.key,
        data: row.data,
      };
      outbox.append(row.table, `${this.#d.name}/${row.key}`, "upsert", envelope);
      store.setReportHash(row.table, row.key, hash);
      n++;
    }
    return n;
  }

  // ---- helpers -------------------------------------------------------------

  /** Drops the in-memory instance; the next message restores it from the store. */
  #forget(): void {
    this.#rec = null;
    this.#sim = null;
    this.#ancestors = new Map();
  }

  #safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.#log("error", `verified ${this.#d.name}: policy hook failed`, err);
      return fallback;
    }
  }

  #joined(): InstanceSocket[] {
    return this.#d.sockets().filter((s) => s.info.joined);
  }

  #limitsOf(socket: InstanceSocket): Limits {
    let l = this.#limits.get(socket);
    if (!l) {
      const now = this.#d.now();
      l = {
        segment: new TokenBucket(SEGMENT_LIMIT, now),
        import: new TokenBucket(IMPORT_LIMIT, now),
        join: new TokenBucket(JOIN_LIMIT, now),
        ping: new TokenBucket(PING_LIMIT, now),
        bank: new TokenBucket(BANK_LIMIT, now),
      };
      this.#limits.set(socket, l);
    }
    return l;
  }

  #send(socket: InstanceSocket, msg: VerifiedServerMessage): void {
    try {
      socket.send(encodeVerifiedServerMessage(msg));
    } catch {
      // Socket went away; its close handler cleans up.
    }
  }

  /** The bank saga's terminal anomalies (ADR 0007 R2: a conflicting refund or credit). */
  readonly #sagaLog = (message: string, data?: unknown): void => this.#log("error", message, data);

  #log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    if (this.#d.log) this.#d.log(level, message, data);
    else if (level === "error") console.error(message, data ?? "");
    else if (level === "warn") console.warn(message, data ?? "");
  }
}
