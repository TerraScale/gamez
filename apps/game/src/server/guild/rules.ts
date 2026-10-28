/**
 * Pure guild rules (wave-B.md §6): names, tags and ids. Shared by the
 * /api/guilds route (answers bad_name / bad_tag early) and GuildRoster
 * (defends the DO). No I/O.
 */
import { guildSlug } from "../contracts.ts";

export const GUILD_NAME_MIN = 3;
export const GUILD_NAME_MAX = 32;
export const GUILD_TAG_MIN = 2;
export const GUILD_TAG_MAX = 5;

/** Letters, digits, single spaces or hyphens inside; starts and ends with a letter or digit. */
const NAME_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9 -]*[A-Za-z0-9])?$/;
const TAG_SHAPE = /^[A-Z0-9]{2,5}$/;

/**
 * Path segments the guild routes use themselves. A guild with one of these ids
 * would be unreachable through GET /api/guilds/:id, so they are not valid names.
 */
const RESERVED_IDS = new Set(["mine", "leave", "kick"]);

export type NameCheck =
  | { ok: true; name: string; id: string }
  | { ok: false; code: "bad_name"; message: string };

/** Validates a display name; `id` is its guild id (guildSlug), the GuildDO name. */
export function checkGuildName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return bad("bad_name", "name must be text");
  const name = raw.trim();
  if (name.length < GUILD_NAME_MIN || name.length > GUILD_NAME_MAX) {
    return bad("bad_name", `name must be ${GUILD_NAME_MIN}-${GUILD_NAME_MAX} characters`);
  }
  if (!NAME_SHAPE.test(name)) {
    return bad("bad_name", "name may use letters, digits, spaces and hyphens only");
  }
  const id = guildSlug(name);
  if (id === null) return bad("bad_name", "name is too long once spaces are joined");
  if (RESERVED_IDS.has(id)) return bad("bad_name", "that name is reserved");
  return { ok: true, name, id };
}

export type TagCheck = { ok: true; tag: string } | { ok: false; code: "bad_tag"; message: string };

/** Validates a tag: 2..5 uppercase letters or digits (no implicit uppercasing). */
export function checkGuildTag(raw: unknown): TagCheck {
  if (typeof raw !== "string" || !TAG_SHAPE.test(raw)) {
    return {
      ok: false,
      code: "bad_tag",
      message: `tag must be ${GUILD_TAG_MIN}-${GUILD_TAG_MAX} characters, A-Z or 0-9`,
    };
  }
  return { ok: true, tag: raw };
}

/** True for a well-formed guild id (a canonical slug of 3..24 characters). */
export function isGuildId(id: string): boolean {
  return guildSlug(id) === id;
}

function bad(code: "bad_name", message: string): { ok: false; code: "bad_name"; message: string } {
  return { ok: false, code, message };
}
