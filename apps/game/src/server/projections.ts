import type { Projection, ProjectionMap } from "@gamez/sync";
import type { CharacterSummary } from "./contracts.ts";

/** D1 read-model projections (tables live in migrations/). */
export const characterSummary: Projection<CharacterSummary> = {
  table: "character_summary",
  pkColumn: "character_id",
  toRow: (p) => ({
    account_id: p.accountId,
    mode: p.mode,
    name: p.name,
    x: p.x,
    y: p.y,
  }),
};

export const projections: ProjectionMap = {
  [characterSummary.table]: characterSummary,
};
