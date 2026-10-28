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
}: {
  tags: readonly string[];
  color: string;
  size?: number;
}) {
  const tag = skillGlyphTag(tags);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-glyph={tag}
      style={{ display: "block", flex: "none" }}
    >
      {glyphBody(tag, color)}
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
