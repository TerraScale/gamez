/** Inline SVG glyphs for items (by category), skills (by tag) and potions (by kind). No art needed. */
import type { ReactNode } from "react";
import type { ItemCategory } from "../../types.ts";

/** Base attributes of every glyph stroke. Spread first, so explicit props win. */
const BASE = {
  fill: "none",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ITEM_PATHS: Record<ItemCategory, string[]> = {
  weapon: ["M6 26 L22 6 L26 6 L26 10 L10 26 Z", "M6 22 L10 26 L7 29 L3 25 Z"],
  shield: ["M16 4 L26 8 V16 C26 22 21 27 16 29 C11 27 6 22 6 16 V8 Z"],
  helm: ["M7 22 C7 9 25 9 25 22 V25 H7 Z", "M7 18 H25"],
  armor: ["M10 6 L16 10 L22 6 L28 10 L25 16 L24 27 H8 L7 16 L4 10 Z"],
  gloves: ["M9 16 V9 H12 V15", "M14 15 V6 H17 V15", "M19 15 V7 H22 V16 L25 19 V26 H9 Z"],
  boots: ["M10 5 H18 V18 L26 20 V27 H8 V5 Z"],
  ring: ["M9 18 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0"],
  amulet: ["M8 4 Q16 16 24 4", "M11 14 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0"],
  potion: ["M13 4 H19 V10 L24 20 V26 Q24 28 22 28 H10 Q8 28 8 26 V20 L13 10 Z"],
};

export function ItemIcon({
  category,
  color,
  size = 32,
}: {
  category: ItemCategory;
  color: string;
  size?: number;
}) {
  const filled = category === "potion";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "none" }}
    >
      {ITEM_PATHS[category].map((d) => (
        <path key={d} {...BASE} d={d} stroke={color} fill={filled ? `${color}55` : "none"} />
      ))}
    </svg>
  );
}

const TAG_PRIORITY = [
  "summon",
  "heal",
  "aoe",
  "ranged",
  "melee",
  "dot",
  "buff",
  "mobility",
  "control",
  "single",
  "basic",
] as const;

/** The glyph shape for a skill, picked by its most specific tag ("none" when untagged). */
export function skillGlyphTag(tags: readonly string[]): string {
  for (const t of TAG_PRIORITY) if (tags.includes(t)) return t;
  return "none";
}

/** A skill's own glyph: `fill` paths get a soft tint, `stroke` paths are outlines. */
export interface SkillGlyph {
  fill?: string[];
  stroke: string[];
}

/**
 * One distinct glyph per hero skill (client only, keyed by skill id). Skills
 * that share a tag used to look alike; these never repeat. Skills not listed
 * here fall back to the tag glyph (SkillIcon).
 */
export const SKILL_GLYPHS: Readonly<Record<string, SkillGlyph>> = {
  // Warrior
  "classic.skill.attack": { stroke: ["M7 25 L24 8", "M9 20 L12 23", "M22 6 L26 6 L26 10"] },
  "classic.skill.mend": {
    fill: ["M13 5 H19 V13 H27 V19 H19 V27 H13 V19 H5 V13 H13 Z"],
    stroke: ["M13 5 H19 V13 H27 V19 H19 V27 H13 V19 H5 V13 H13 Z"],
  },
  "classic.skill.cleave": { stroke: ["M4 20 Q16 4 28 20", "M4 28 Q16 14 28 28"] },
  "classic.skill.whirl": { stroke: ["M26 16 A10 10 0 1 1 20 6.5", "M20 2 L20 7 L25 7"] },
  "classic.skill.rally": { stroke: ["M9 4 V28", "M9 5 H25 L21 10.5 L25 16 H9"] },
  "classic.skill.charge": { stroke: ["M4 16 H23", "M15 8 L23 16 L15 24"] },
  // Rogue
  "classic.skill.multishot": { stroke: ["M5 27 L26 6", "M5 27 L27 17", "M5 27 L17 5"] },
  // A poisoned arrow: a shaft and head with fletching, and three drips falling from the tip.
  "classic.skill.venom_shot": {
    fill: ["M27 4 L15 8 L24 17 Z", "M22 19 L24.5 23.5 A2.5 2.5 0 1 1 19.5 23.5 Z"],
    stroke: [
      "M27 4 L15 8 L24 17 Z",
      "M4 28 L14 18",
      "M3 21 L7 25",
      "M7 17 L15 25",
      "M22 19 L24.5 23.5 A2.5 2.5 0 1 1 19.5 23.5 Z",
    ],
  },
  "classic.skill.spark_sentry": { stroke: ["M10 13 H22 V23 H10 Z", "M16 13 V5", "M11 5 H21"] },
  "classic.skill.tumble": {
    stroke: ["M8 22 C4 12 12 4 20 8 C26 12 24 20 18 22 C14 24 12 18 16 15"],
  },
  // Sorcerer
  "classic.skill.ember_bolt": {
    fill: [
      "M16 28 C10 24 9 18 13 13 C13 17 15 18 16 17 C15 12 18 8 19 4 C23 9 24 13 23 19 C25 17 25 15 25 14 C28 18 27 24 16 28 Z",
    ],
    stroke: [
      "M16 28 C10 24 9 18 13 13 C13 17 15 18 16 17 C15 12 18 8 19 4 C23 9 24 13 23 19 C25 17 25 15 25 14 C28 18 27 24 16 28 Z",
    ],
  },
  "classic.skill.frost_ring": {
    stroke: [
      "M16 4 V28",
      "M5 10 L27 22",
      "M5 22 L27 10",
      "M13 6 L16 9 L19 6",
      "M13 26 L16 23 L19 26",
    ],
  },
  "classic.skill.arc_chain": {
    fill: ["M18 3 L8 18 H15 L13 29 L24 13 H17 Z"],
    stroke: ["M18 3 L8 18 H15 L13 29 L24 13 H17 Z"],
  },
  "classic.skill.cinder_orb": {
    fill: ["M16 9 A7 7 0 1 1 15.9 9 Z"],
    stroke: ["M26 16 A10 10 0 1 1 6 16 A10 10 0 1 1 26 16"],
  },
  "classic.skill.phase_step": {
    stroke: [
      "M8 27 V14 A8 8 0 0 1 24 14 V27 L20 23 L16 27 L12 23 L8 27",
      "M13 14 H13.5 M19 14 H19.5",
    ],
  },
};

/** The key a skill glyph is drawn by: its own id when it has a glyph, else its tag glyph. */
export function skillGlyphKey(skillId: string | null | undefined, tags: readonly string[]): string {
  return skillId && Object.hasOwn(SKILL_GLYPHS, skillId) ? skillId : skillGlyphTag(tags);
}

function ownGlyph(glyph: SkillGlyph, color: string): ReactNode {
  const soft = `${color}44`;
  return (
    <>
      {(glyph.fill ?? []).map((d) => (
        <path key={`f-${d}`} {...BASE} d={d} stroke={color} fill={soft} />
      ))}
      {glyph.stroke.map((d) => (
        <path key={`s-${d}`} {...BASE} d={d} stroke={color} />
      ))}
    </>
  );
}

function glyphBody(tag: string, color: string): ReactNode {
  const soft = `${color}44`;
  switch (tag) {
    case "summon":
      return (
        <polygon
          {...BASE}
          points="16,4 19.5,12 28,12.5 21.5,18 24,27 16,22 8,27 10.5,18 4,12.5 12.5,12"
          stroke={color}
          fill={soft}
        />
      );
    case "heal":
      return (
        <path
          {...BASE}
          d="M13 5 H19 V13 H27 V19 H19 V27 H13 V19 H5 V13 H13 Z"
          stroke={color}
          fill={soft}
        />
      );
    case "aoe":
      return (
        <>
          <circle {...BASE} cx="16" cy="16" r="11" stroke={color} />
          <circle {...BASE} cx="16" cy="16" r="5" stroke={color} />
        </>
      );
    case "ranged":
      return <path {...BASE} d="M5 27 L27 5 M19 5 H27 V13" stroke={color} />;
    case "melee":
      return <path {...BASE} d="M6 22 Q16 2 26 10" stroke={color} strokeWidth={3} />;
    case "dot":
      return (
        <path
          {...BASE}
          d="M16 4 C22 12 24 16 24 20 A8 8 0 0 1 8 20 C8 16 10 12 16 4 Z"
          stroke={color}
          fill={soft}
        />
      );
    case "buff":
      return <path {...BASE} d="M7 20 L16 11 L25 20 M7 26 L16 17 L25 26" stroke={color} />;
    case "mobility":
      return <path {...BASE} d="M6 12 L14 16 L6 20 M16 12 L24 16 L16 20" stroke={color} />;
    case "control":
      return <path {...BASE} d="M8 8 L24 24 M24 8 L8 24" stroke={color} />;
    default:
      return <path {...BASE} d="M16 5 L27 16 L16 27 L5 16 Z" stroke={color} fill={`${color}33`} />;
  }
}

export function SkillIcon({
  tags,
  color,
  size = 28,
  skillId,
}: {
  tags: readonly string[];
  color: string;
  size?: number;
  /** Skill id: picks the skill's own glyph (falls back to the tag glyph). */
  skillId?: string | null;
}) {
  const key = skillGlyphKey(skillId, tags);
  const own = Object.hasOwn(SKILL_GLYPHS, key) ? SKILL_GLYPHS[key] : undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-glyph={key}
      style={{ display: "block", flex: "none" }}
    >
      {own ? ownGlyph(own, color) : glyphBody(key, color)}
    </svg>
  );
}

const POTION_COLOR = { life: "#e0493a", mana: "#4d8fff", rejuv: "#b98cff" } as const;

export function potionColor(kind: "life" | "mana" | "rejuv" | null): string {
  return kind === null ? "#6d6353" : POTION_COLOR[kind];
}

export function PotionIcon({
  kind,
  size = 28,
}: {
  kind: "life" | "mana" | "rejuv" | null;
  size?: number;
}) {
  return <ItemIcon category="potion" color={potionColor(kind)} size={size} />;
}
