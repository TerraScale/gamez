/**
 * World fixtures of a presence chunk (docs/design/wave-C.md §5.4, §12): entities
 * that belong to the world rather than to a connected player, e.g. the ghost
 * shopkeepers on leased plots ("shops:p1"). Owned by the ChunkDO, set per
 * group through ChunkFixtureApi.setFixtures(group, fixtures).
 *
 * Rules:
 * - group: lowercase id (`^[a-z][a-z0-9_-]{0,31}$`); every fixture id starts
 *   with "<group>:" and is unique; at most MAX_FIXTURES_PER_GROUP per group;
 * - kind "shopkeeper" only; pos inside the world; fixtures never move
 *   (path [], speed 0, pathStartedAt 0) and never time out;
 * - name, appearance and tag are sanitised like poses (control characters
 *   stripped, length capped, appearance pattern), never rejected;
 * - a set replaces the whole group atomically and survives restarts (SQLite).
 *
 * Logic only, on a SqlStore, so tests run it on node:sqlite (FakeSqlStorage).
 */
import type { EntityId, EntityKind, EntityState, TilePos } from "@gamez/protocol";
import type { SqlStore } from "../contracts.ts";
import { sanitiseAppearance, sanitiseTag, type PoseBounds } from "./pose.ts";

export const MAX_FIXTURES_PER_GROUP = 64;
export const MAX_FIXTURE_ID = 64;
export const MAX_FIXTURE_NAME = 32;
export const FIXTURE_KINDS: readonly EntityKind[] = ["shopkeeper"];
export const GROUP_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** Characters allowed after "<group>:" in a fixture id. */
const ID_REST_PATTERN = /^[A-Za-z0-9_.:/-]+$/;
const CONTROL = /\p{Cc}/gu;

export type FixtureErrorCode =
  | "bad-group"
  | "bad-fixtures"
  | "too-many"
  | "bad-id"
  | "duplicate-id"
  | "bad-kind"
  | "out-of-bounds";

/** Thrown for a fixture set that cannot be accepted; nothing is changed. */
export class FixtureError extends Error {
  constructor(
    readonly code: FixtureErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FixtureError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Display name without control characters, at most MAX_FIXTURE_NAME code points, never empty. */
export function sanitiseFixtureName(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const clean = Array.from(v.replace(CONTROL, "").trim()).slice(0, MAX_FIXTURE_NAME).join("");
  return clean.length > 0 ? clean : fallback;
}

/** True when `id` names a fixture of some group ("<group>:<rest>"). */
export function isFixtureIdOf(group: string, id: string): boolean {
  if (!id.startsWith(`${group}:`) || id.length > MAX_FIXTURE_ID) return false;
  return ID_REST_PATTERN.test(id.slice(group.length + 1));
}

/**
 * Checks and sanitises a raw fixture set (it arrives over RPC or a dev route,
 * so its shape is unknown). Throws FixtureError on anything structural.
 */
export function validateFixtures(group: unknown, raw: unknown, bounds: PoseBounds): EntityState[] {
  if (typeof group !== "string" || !GROUP_PATTERN.test(group)) {
    throw new FixtureError("bad-group", `group must match ${GROUP_PATTERN}`);
  }
  if (!Array.isArray(raw)) throw new FixtureError("bad-fixtures", "fixtures must be an array");
  if (raw.length > MAX_FIXTURES_PER_GROUP) {
    throw new FixtureError("too-many", `at most ${MAX_FIXTURES_PER_GROUP} fixtures per group`);
  }
  const seen = new Set<string>();
  const out: EntityState[] = [];
  for (const f of raw) {
    if (!isRecord(f)) throw new FixtureError("bad-fixtures", "a fixture must be an object");
    const id = f.id;
    if (typeof id !== "string" || !isFixtureIdOf(group, id)) {
      throw new FixtureError("bad-id", `fixture ids must start with "${group}:"`);
    }
    if (seen.has(id)) throw new FixtureError("duplicate-id", `duplicate fixture id ${id}`);
    seen.add(id);
    if (typeof f.kind !== "string" || !FIXTURE_KINDS.includes(f.kind as EntityKind)) {
      throw new FixtureError("bad-kind", `fixture kind must be one of ${FIXTURE_KINDS.join(", ")}`);
    }
    const pos = f.pos;
    if (
      !isRecord(pos) ||
      !Number.isInteger(pos.x) ||
      !Number.isInteger(pos.y) ||
      (pos.x as number) < 0 ||
      (pos.y as number) < 0 ||
      (pos.x as number) >= bounds.width ||
      (pos.y as number) >= bounds.height
    ) {
      throw new FixtureError("out-of-bounds", `fixture ${id} must stand inside the world`);
    }
    const state: EntityState = {
      id,
      kind: f.kind as EntityKind,
      name: sanitiseFixtureName(f.name, "Shopkeeper"),
      appearance: sanitiseAppearance(f.appearance),
      pos: { x: pos.x as number, y: pos.y as number } satisfies TilePos,
      path: [],
      pathStartedAt: 0,
      speed: 0,
    };
    const tag = sanitiseTag(f.tag);
    if (tag !== undefined) state.tag = tag;
    out.push(state);
  }
  return out;
}

/** What a group replacement changed, for the chunk's next delta. */
export interface FixtureChange {
  upserts: EntityState[];
  removes: EntityId[];
}

interface FixtureRow extends Record<string, SqlStorageValue> {
  id: string;
  grp: string;
  state: string;
}

/** Persistent fixture table of one chunk, mirrored in memory. */
export class FixtureStore {
  readonly #store: SqlStore;
  readonly #byId = new Map<EntityId, { group: string; state: EntityState }>();

  constructor(store: SqlStore) {
    this.#store = store;
    store.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixtures (id TEXT PRIMARY KEY, grp TEXT NOT NULL, state TEXT NOT NULL)",
    );
    for (const row of store.sql.exec<FixtureRow>(
      "SELECT id, grp, state FROM fixtures ORDER BY id",
    )) {
      this.#byId.set(row.id, { group: row.grp, state: JSON.parse(row.state) as EntityState });
    }
  }

  has(id: EntityId): boolean {
    return this.#byId.has(id);
  }

  get(id: EntityId): EntityState | undefined {
    return this.#byId.get(id)?.state;
  }

  /** Every fixture, in id order. */
  all(): EntityState[] {
    return [...this.#byId.keys()].sort().map((id) => this.#byId.get(id)!.state);
  }

  /** Fixtures of one group, in id order. */
  group(group: string): EntityState[] {
    return this.all().filter((s) => this.#byId.get(s.id)!.group === group);
  }

  get size(): number {
    return this.#byId.size;
  }

  /**
   * Replaces a group with `fixtures` (already validated) in one transaction.
   * Unchanged fixtures produce no upsert; ids in `reserved` (live avatars) are refused.
   */
  replace(
    group: string,
    fixtures: EntityState[],
    reserved: (id: EntityId) => boolean = () => false,
  ): FixtureChange {
    for (const f of fixtures) {
      if (reserved(f.id)) throw new FixtureError("bad-id", `fixture id ${f.id} is in use`);
      const other = this.#byId.get(f.id);
      if (other && other.group !== group) {
        throw new FixtureError("bad-id", `fixture id ${f.id} belongs to group ${other.group}`);
      }
    }
    const next = new Map(fixtures.map((f) => [f.id, f]));
    const upserts: EntityState[] = [];
    const removes: EntityId[] = [];
    for (const [id, f] of this.#byId) {
      if (f.group === group && !next.has(id)) removes.push(id);
    }
    for (const f of fixtures) {
      const old = this.#byId.get(f.id);
      if (!old || JSON.stringify(old.state) !== JSON.stringify(f)) upserts.push(f);
    }
    if (upserts.length === 0 && removes.length === 0) return { upserts, removes };
    this.#store.transactionSync(() => {
      for (const id of removes) this.#store.sql.exec("DELETE FROM fixtures WHERE id = ?", id);
      for (const f of upserts) {
        this.#store.sql.exec(
          "INSERT OR REPLACE INTO fixtures (id, grp, state) VALUES (?, ?, ?)",
          f.id,
          group,
          JSON.stringify(f),
        );
      }
    });
    for (const id of removes) this.#byId.delete(id);
    for (const f of upserts) this.#byId.set(f.id, { group, state: f });
    removes.sort();
    return { upserts, removes };
  }
}
