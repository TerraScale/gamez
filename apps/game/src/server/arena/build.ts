/**
 * Arena build helpers (server side): strict validation of client-supplied
 * builds (dev injection only; exportBuild output is trusted) and the
 * "Sparring Shade" ghost derived from a player's own build (wave-C.md §6.3).
 */
import type { ArenaBuild, ArenaSkill, ArenaSkillKind } from "@gamez/protocol";

export const SHADE_ACCOUNT_ID = "arena.shade";
export const SHADE_NAME = "Sparring Shade";
/** Shade stats as a percent of the player's build. */
export const SHADE_PERCENT = 90;

const SKILL_KINDS: readonly ArenaSkillKind[] = ["strike", "projectile", "nova", "heal", "shield"];

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

function isText(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

const APPEARANCE = /^unit\.hero(\.[a-z0-9_]+)*$/;
const ID = /^[a-z0-9_.]{1,60}$/;

function skillOf(v: unknown): ArenaSkill | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (!isText(s.id, 1, 80) || !isText(s.name, 1, 40)) return null;
  if (typeof s.kind !== "string" || !SKILL_KINDS.includes(s.kind as ArenaSkillKind)) return null;
  if (!isInt(s.power, 1, 1000) || !isInt(s.cooldown, 1, 400) || !isInt(s.range, 0, 8)) return null;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind as ArenaSkillKind,
    power: s.power,
    cooldown: s.cooldown,
    range: s.range,
  };
}

/**
 * Validates a client-supplied build and stamps the caller's identity onto it.
 * Returns null for anything out of the ArenaBuild ranges (protocol arena.ts).
 */
export function checkBuild(
  input: unknown,
  party: { accountId: string; displayName: string },
): ArenaBuild | null {
  if (!input || typeof input !== "object") return null;
  const b = input as Record<string, unknown>;
  if (!isText(b.name, 1, 40) || !ID.test(String(b.classId))) return null;
  if (typeof b.classId !== "string" || !isText(b.appearance, 1, 60)) return null;
  if (!APPEARANCE.test(b.appearance)) return null;
  if (!isInt(b.level, 1, 999) || !isInt(b.maxHp, 1, 1_000_000)) return null;
  if (!isInt(b.dmgMin, 0, 100_000) || !isInt(b.dmgMax, 0, 100_000)) return null;
  if (!((b.dmgMin as number) <= (b.dmgMax as number))) return null;
  if (!isInt(b.attackRate, 1, 100) || !isInt(b.armor, 0, 100_000)) return null;
  if (!isInt(b.resist, 0, 75) || !isInt(b.critPct, 0, 75)) return null;
  if (!isInt(b.moveSpeed, 1, 8) || !isInt(b.power, 0, 1_000_000_000)) return null;
  if (!isText(b.sourceHash, 1, 64)) return null;
  if (!Array.isArray(b.skills) || b.skills.length > 4) return null;
  const skills: ArenaSkill[] = [];
  for (const raw of b.skills) {
    const s = skillOf(raw);
    if (!s) return null;
    skills.push(s);
  }
  return {
    mode: "classic",
    accountId: party.accountId,
    name: b.name,
    displayName: party.displayName,
    classId: b.classId,
    level: b.level as number,
    appearance: b.appearance,
    maxHp: b.maxHp as number,
    dmgMin: b.dmgMin as number,
    dmgMax: b.dmgMax as number,
    attackRate: b.attackRate as number,
    armor: b.armor as number,
    resist: b.resist as number,
    critPct: b.critPct as number,
    moveSpeed: b.moveSpeed as number,
    skills,
    power: b.power as number,
    sourceHash: b.sourceHash,
  };
}

const scaled = (n: number, min = 0): number => Math.max(min, Math.floor((n * SHADE_PERCENT) / 100));

/**
 * The Sparring Shade: the player's own build at 90 % of its numbers (never
 * below the field minimum), under a fixed name. Unrated; a fallback opponent.
 */
export function shadeOf(build: ArenaBuild): ArenaBuild {
  const dmgMin = scaled(build.dmgMin);
  return {
    ...build,
    accountId: SHADE_ACCOUNT_ID,
    displayName: SHADE_NAME,
    name: SHADE_NAME,
    maxHp: scaled(build.maxHp, 1),
    dmgMin,
    dmgMax: Math.max(dmgMin, scaled(build.dmgMax)),
    attackRate: scaled(build.attackRate, 1),
    armor: scaled(build.armor),
    resist: scaled(build.resist),
    critPct: scaled(build.critPct),
    power: scaled(build.power),
    skills: build.skills.map((s) => ({ ...s, power: scaled(s.power, 1) })),
  };
}
