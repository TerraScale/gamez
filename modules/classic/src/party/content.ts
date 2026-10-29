/**
 * Party content (CONTRACT, architect): the PartyProto and the patches that
 * make existing content party-aware (docs/design/party.md §8). Builders tune
 * NUMBERS here only with the balance test (tests/party.balance.test.ts).
 */
import type { Registry } from "@gamez/kernel";
import { DEFAULT_PARTY_PROTO } from "../rules.ts";
import { tiles } from "../fixed.ts";
import { KIND, PARTY_ID, type ClassProto, type PartyProto, type SkillProto } from "../types.ts";

/** Formation line per class (ClassProto.partyRole). */
export const CLASS_ROLES: Readonly<Record<string, "front" | "back">> = {
  "classic.warrior": "front",
  "classic.rogue": "back",
  "classic.sorcerer": "back",
};

/** Mend also heals party members within this radius (SkillProto.heal.allyRadius). */
export const MEND_ALLY_RADIUS = tiles(5);

export function definePartyContent(reg: Registry): void {
  reg.define<PartyProto>(KIND.party, PARTY_ID, structuredClone(DEFAULT_PARTY_PROTO));
}

export function patchPartyContent(reg: Registry): void {
  for (const [id, role] of Object.entries(CLASS_ROLES).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!reg.get<ClassProto>(KIND.class, id)) continue;
    reg.patch<ClassProto>(KIND.class, id, (c) => {
      c.partyRole = role;
    });
  }
  if (reg.get<SkillProto>(KIND.skill, "classic.skill.mend")) {
    reg.patch<SkillProto>(KIND.skill, "classic.skill.mend", (s) => {
      if (s.heal) s.heal.allyRadius = MEND_ALLY_RADIUS;
    });
  }
}
