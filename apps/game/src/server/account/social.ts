/**
 * AccountDO social state (wave-B.md §5.4, §6.2): the block list and the single
 * guild slot. Logic over SqlStore; do/account.ts delegates here.
 *
 * Guild saga (idempotent by opId): reserveGuild -> GuildDO.create/join ->
 * confirmGuild, or releaseGuild on failure. A reservation older than
 * GUILD_RESERVATION_MS without confirm is treated as free (crashed saga).
 * Block list: at most BLOCK_LIMIT account ids, returned sorted.
 */
import type { GuildRole } from "@gamez/protocol";
import type { GuildMembership, SqlStore } from "../contracts.ts";

export const BLOCK_LIMIT = 200;
export const BLOCK_TARGET_MAX = 64;
export const GUILD_RESERVATION_MS = 60_000;

/** Typed rejection of a social change (the RPC surfaces it as an Error with this code). */
export class SocialError extends Error {
  constructor(
    readonly code: "block_limit" | "bad_target" | "self_block" | "slot_taken",
    message: string,
  ) {
    super(message);
    this.name = "SocialError";
  }
}

type SlotRow = {
  state: "reserved" | "member";
  op_id: string;
  guild_id: string;
  tag: string | null;
  role: GuildRole | null;
  reserved_at: number;
};

export class AccountSocial {
  /**
   * `owner` is the account this state belongs to, when known: setBlocked
   * refuses to block it. do/account.ts passes the DO's accountId.
   */
  constructor(
    readonly store: SqlStore,
    readonly now: () => number = Date.now,
    readonly owner: string | null = null,
  ) {}

  init(): void {
    const sql = this.store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS social_block (
      target TEXT PRIMARY KEY
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS social_guild (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'member')),
      op_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      tag TEXT,
      role TEXT,
      reserved_at INTEGER NOT NULL
    )`);
  }

  // ---- block list -----------------------------------------------------------

  blocks(): string[] {
    return this.store.sql
      .exec<{ target: string }>("SELECT target FROM social_block ORDER BY target")
      .toArray()
      .map((r) => r.target);
  }

  setBlocked(target: string, blocked: boolean): string[] {
    if (typeof target !== "string" || target.length === 0 || target.length > BLOCK_TARGET_MAX) {
      throw new SocialError("bad_target", "block target must be an account id");
    }
    if (this.owner !== null && target === this.owner) {
      throw new SocialError("self_block", "cannot block yourself");
    }
    return this.store.transactionSync(() => {
      if (!blocked) {
        this.store.sql.exec("DELETE FROM social_block WHERE target = ?", target);
        return this.blocks();
      }
      const known =
        this.store.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM social_block WHERE target = ?", target)
          .one().n > 0;
      if (!known) {
        const count = this.store.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM social_block")
          .one().n;
        if (count >= BLOCK_LIMIT) {
          throw new SocialError("block_limit", `at most ${BLOCK_LIMIT} blocked accounts`);
        }
        this.store.sql.exec("INSERT INTO social_block (target) VALUES (?)", target);
      }
      return this.blocks();
    });
  }

  // ---- guild slot -----------------------------------------------------------

  /** The confirmed guild membership, or null (a reservation is not membership). */
  guild(): GuildMembership | null {
    const slot = this.#slot();
    return slot ? membershipOf(slot) : null;
  }

  /**
   * Step 1 of the saga. Succeeds when the slot is free, expired, or already
   * held by this same operation for this guild (a retry). Otherwise fails and
   * reports the confirmed membership when there is one (null while another
   * operation's reservation is live).
   */
  reserveGuild(opId: string, guildId: string): { ok: boolean; current: GuildMembership | null } {
    return this.store.transactionSync(() => {
      const slot = this.#slot();
      if (slot === null) {
        this.#write(opId, guildId, null, null, "reserved");
        return { ok: true, current: null };
      }
      if (slot.op_id === opId && slot.guild_id === guildId) {
        return { ok: true, current: null };
      }
      if (slot.state === "member") {
        return { ok: false, current: membershipOf(slot) };
      }
      if (this.now() - slot.reserved_at > GUILD_RESERVATION_MS) {
        this.#write(opId, guildId, null, null, "reserved");
        return { ok: true, current: null };
      }
      return { ok: false, current: null };
    });
  }

  /**
   * Step 2 (GuildDO accepted): stores the membership. Idempotent for the same
   * guild. Throws SocialError("slot_taken") when another guild or another live
   * reservation holds the slot.
   */
  confirmGuild(opId: string, membership: GuildMembership): void {
    this.store.transactionSync(() => {
      const slot = this.#slot();
      if (slot !== null) {
        if (slot.state === "member" && slot.guild_id !== membership.guildId) {
          throw new SocialError("slot_taken", "already in another guild");
        }
        if (slot.state === "reserved" && slot.op_id !== opId) {
          if (this.now() - slot.reserved_at <= GUILD_RESERVATION_MS) {
            throw new SocialError("slot_taken", "guild change in progress");
          }
        }
      }
      this.#write(opId, membership.guildId, membership.tag, membership.role, "member");
    });
  }

  /**
   * Undo of step 1, or leave/kick. Clears the slot when it holds `guildId`
   * (any confirmed membership of it, or a reservation made by `opId`).
   * Idempotent.
   */
  releaseGuild(opId: string, guildId: string): void {
    this.store.sql.exec(
      "DELETE FROM social_guild WHERE singleton = 1 AND guild_id = ? AND (state = 'member' OR op_id = ?)",
      guildId,
      opId,
    );
  }

  #slot(): SlotRow | null {
    return (
      this.store.sql
        .exec<SlotRow>(
          "SELECT state, op_id, guild_id, tag, role, reserved_at FROM social_guild WHERE singleton = 1",
        )
        .toArray()[0] ?? null
    );
  }

  #write(
    opId: string,
    guildId: string,
    tag: string | null,
    role: GuildRole | null,
    state: "reserved" | "member",
  ): void {
    this.store.sql.exec(
      `INSERT OR REPLACE INTO social_guild (singleton, state, op_id, guild_id, tag, role, reserved_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      state,
      opId,
      guildId,
      tag,
      role,
      this.now(),
    );
  }
}

function membershipOf(slot: SlotRow): GuildMembership | null {
  if (slot.state !== "member" || slot.tag === null || slot.role === null) return null;
  return { guildId: slot.guild_id, tag: slot.tag, role: slot.role };
}
