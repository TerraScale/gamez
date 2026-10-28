/**
 * One guild's state: info, roster, roles (wave-B.md §6). Logic over SqlStore
 * plus the DO's Outbox; GuildDO (do/guild.ts) delegates here and flushes.
 *
 * Every change appends one "guild_index" outbox record in the same
 * transaction: an upsert with the new summary, or a delete (tombstone) when
 * the last member leaves and the guild disbands.
 */
import { GUILD_MAX_MEMBERS, type GuildInfo, type GuildRole } from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type { GuildApi, GuildIndexPayload, SqlStore } from "../contracts.ts";
import { checkGuildName, checkGuildTag } from "./rules.ts";

export interface RosterOptions {
  /** The guild id (guildSlug of its name) = the GuildDO name. */
  id: string;
  store: SqlStore;
  outbox: Outbox;
  now?: () => number;
}

type MetaRow = {
  name: string;
  tag: string;
  open: number;
  created_at: number;
};

type MemberRow = {
  account_id: string;
  display_name: string;
  role: GuildRole;
  joined_at: number;
  ord: number;
};

type CreateResult = Awaited<ReturnType<GuildApi["create"]>>;
type JoinResult = Awaited<ReturnType<GuildApi["join"]>>;
type KickResult = Awaited<ReturnType<GuildApi["kick"]>>;

const ROLE_ORDER = "CASE role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END";

export class GuildRoster {
  readonly #id: string;
  readonly #store: SqlStore;
  readonly #outbox: Outbox;
  readonly #now: () => number;

  constructor(opts: RosterOptions) {
    this.#id = opts.id;
    this.#store = opts.store;
    this.#outbox = opts.outbox;
    this.#now = opts.now ?? Date.now;
  }

  init(): void {
    const sql = this.#store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS guild_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      open INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS guild_member (
      account_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('leader', 'officer', 'member')),
      joined_at INTEGER NOT NULL,
      ord INTEGER NOT NULL
    )`);
  }

  info(): GuildInfo | null {
    const meta = this.#meta();
    if (meta === null) return null;
    const members = this.#store.sql
      .exec<MemberRow>(
        `SELECT account_id, display_name, role, joined_at, ord FROM guild_member
         ORDER BY ${ROLE_ORDER}, ord`,
      )
      .toArray();
    return {
      id: this.#id,
      name: meta.name,
      tag: meta.tag,
      open: meta.open === 1,
      createdAt: meta.created_at,
      members: members.map((m) => ({
        accountId: m.account_id,
        displayName: m.display_name,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    };
  }

  /**
   * Founds the guild with the founder as leader. Idempotent for the founder:
   * when they already lead it, the existing guild is returned.
   */
  create(input: Parameters<GuildApi["create"]>[0]): CreateResult {
    const name = checkGuildName(input.name);
    if (!name.ok || name.id !== this.#id) return { ok: false, code: "bad_request" };
    const tag = checkGuildTag(input.tag);
    if (!tag.ok) return { ok: false, code: "bad_request" };
    if (typeof input.open !== "boolean") return { ok: false, code: "bad_request" };
    const founder = input.founder;
    if (!founder || !nonEmpty(founder.accountId) || typeof founder.displayName !== "string") {
      return { ok: false, code: "bad_request" };
    }

    const existing = this.#meta();
    if (existing !== null) {
      const row = this.#member(founder.accountId);
      if (row?.role === "leader") return { ok: true, guild: this.info() as GuildInfo };
      return { ok: false, code: "name_taken" };
    }

    this.#store.transactionSync(() => {
      const now = this.#now();
      this.#store.sql.exec(
        "INSERT INTO guild_meta (singleton, name, tag, open, created_at) VALUES (1, ?, ?, ?, ?)",
        name.name,
        tag.tag,
        input.open ? 1 : 0,
        now,
      );
      this.#insertMember(founder.accountId, founder.displayName, "leader", now);
      this.#emit();
    });
    return { ok: true, guild: this.info() as GuildInfo };
  }

  /** Adds a member to an open guild. Already a member: returns the guild (idempotent). */
  join(input: Parameters<GuildApi["join"]>[0]): JoinResult {
    const meta = this.#meta();
    if (meta === null) return { ok: false, code: "not_found" };
    const member = input.member;
    if (!member || !nonEmpty(member.accountId)) return { ok: false, code: "not_found" };
    if (this.#member(member.accountId) !== null) {
      return { ok: true, guild: this.info() as GuildInfo };
    }
    if (meta.open !== 1) return { ok: false, code: "closed" };
    if (this.#count() >= GUILD_MAX_MEMBERS) return { ok: false, code: "full" };

    this.#store.transactionSync(() => {
      this.#insertMember(member.accountId, member.displayName, "member", this.#now());
      this.#emit();
    });
    return { ok: true, guild: this.info() as GuildInfo };
  }

  /**
   * Removes a member. The leader leaving promotes the longest-standing officer,
   * else the longest-standing member. The last member out disbands the guild.
   */
  leave(input: { opId: string; accountId: string }): { guild: GuildInfo | null } {
    if (this.#meta() === null) return { guild: null };
    const me = this.#member(input.accountId);
    if (me === null) return { guild: this.info() };

    this.#store.transactionSync(() => {
      if (me.role === "leader") {
        const heir = this.#store.sql
          .exec<{ account_id: string }>(
            `SELECT account_id FROM guild_member WHERE account_id <> ?
             ORDER BY CASE role WHEN 'officer' THEN 0 ELSE 1 END, ord LIMIT 1`,
            input.accountId,
          )
          .toArray()[0];
        if (heir) {
          this.#store.sql.exec(
            "UPDATE guild_member SET role = 'leader' WHERE account_id = ?",
            heir.account_id,
          );
        }
      }
      this.#store.sql.exec("DELETE FROM guild_member WHERE account_id = ?", input.accountId);
      if (this.#count() === 0) {
        this.#store.sql.exec("DELETE FROM guild_meta WHERE singleton = 1");
      }
      this.#emit();
    });
    return { guild: this.info() };
  }

  /**
   * Removes `target`. The leader may remove officers and members; an officer
   * may remove members only. Nobody removes the leader, and a member removes
   * nobody.
   */
  kick(input: { by: string; target: string }): KickResult {
    if (this.#meta() === null) return { ok: false, code: "not_found" };
    const actor = this.#member(input.by);
    if (actor === null || actor.role === "member") return { ok: false, code: "forbidden" };
    const victim = this.#member(input.target);
    if (victim === null) return { ok: false, code: "not_found" };
    if (victim.role === "leader") return { ok: false, code: "forbidden" };
    if (actor.role === "officer" && victim.role === "officer") {
      return { ok: false, code: "forbidden" };
    }

    this.#store.transactionSync(() => {
      this.#store.sql.exec("DELETE FROM guild_member WHERE account_id = ?", input.target);
      this.#emit();
    });
    return { ok: true, guild: this.info() as GuildInfo };
  }

  // ---- internals ------------------------------------------------------------

  #meta(): MetaRow | null {
    return (
      this.#store.sql
        .exec<MetaRow>("SELECT name, tag, open, created_at FROM guild_meta WHERE singleton = 1")
        .toArray()[0] ?? null
    );
  }

  #member(accountId: string): MemberRow | null {
    return (
      this.#store.sql
        .exec<MemberRow>(
          "SELECT account_id, display_name, role, joined_at, ord FROM guild_member WHERE account_id = ?",
          accountId,
        )
        .toArray()[0] ?? null
    );
  }

  #count(): number {
    return this.#store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM guild_member").one().n;
  }

  #insertMember(accountId: string, displayName: string, role: GuildRole, joinedAt: number): void {
    const { ord } = this.#store.sql
      .exec<{ ord: number }>("SELECT COALESCE(MAX(ord), 0) + 1 AS ord FROM guild_member")
      .one();
    this.#store.sql.exec(
      "INSERT INTO guild_member (account_id, display_name, role, joined_at, ord) VALUES (?, ?, ?, ?, ?)",
      accountId,
      displayName,
      role,
      joinedAt,
      ord,
    );
  }

  /** Appends the guild_index record for the current state (delete when disbanded). */
  #emit(): void {
    const meta = this.#meta();
    if (meta === null) {
      this.#outbox.append("guild_index", this.#id, "delete", null);
      return;
    }
    const leader = this.#store.sql
      .exec<{ account_id: string }>(
        "SELECT account_id FROM guild_member WHERE role = 'leader' LIMIT 1",
      )
      .toArray()[0];
    const payload: GuildIndexPayload = {
      guildId: this.#id,
      name: meta.name,
      tag: meta.tag,
      open: meta.open === 1,
      memberCount: this.#count(),
      leaderId: leader?.account_id ?? "",
      createdAt: meta.created_at,
    };
    this.#outbox.append("guild_index", this.#id, "upsert", payload);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
