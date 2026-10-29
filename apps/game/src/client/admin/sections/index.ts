/**
 * The admin sections, in sidebar order (docs/design/admin-dashboard.md §10.1).
 * CONTRACT (architect): the shell (index.tsx) renders this list; the sidebar
 * groups by `group`. Add a section by adding a file and a line here.
 */
import type { SectionDef } from "../kit/types.ts";
import { configSection } from "./config.tsx";
import { economySection } from "./economy.tsx";
import { gameplaySection } from "./gameplay.tsx";
import { lookupSection } from "./lookup.tsx";
import { monetizationSection } from "./monetization.tsx";
import { overviewSection } from "./overview.tsx";
import { playersSection } from "./players.tsx";
import { socialSection } from "./social.tsx";
import { techSection } from "./tech.tsx";

export const SECTIONS: readonly SectionDef<unknown>[] = [
  overviewSection,
  playersSection,
  lookupSection,
  socialSection,
  gameplaySection,
  economySection,
  monetizationSection,
  techSection,
  configSection,
];

export const DEFAULT_SECTION = "overview";

export function sectionById(id: string): SectionDef<unknown> | undefined {
  return SECTIONS.find((s) => s.id === id);
}
