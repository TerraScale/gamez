/**
 * Module "classic.party" (docs/design/party.md). Several heroes in one sim:
 * the party resource (created lazily by the first party action), recruit /
 * dismiss / rename / reorder / control / config / buySlot / give actions,
 * revive and give HeroCommands, town revive, control auto-switch on death.
 *
 * Contract files (architect): content.ts (PartyProto + patches), shared.ts
 * (helpers every module uses). Builder files: actions.ts, systems.ts, ops.ts.
 * The rest of the party lives in the owning modules: multi-hero systems
 * (core, combat, monsters, world, progression, items...), the party AI
 * (classic.auto: SYSTEM.autoParty) and the client (HUD, scene).
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { partyActions } from "./actions.ts";
import { definePartyContent, patchPartyContent } from "./content.ts";
import { partySystems } from "./systems.ts";

export * from "./shared.ts";
export { CLASS_ROLES, MEND_ALLY_RADIUS } from "./content.ts";

export const classicParty = defineModule({
  id: MODULE.party,
  version: "1.0.0",
  // Like classic.talents: only core is required, so partial module sets (tests,
  // fixtures) still load; the rest only fixes the load order when present.
  deps: [MODULE.core],
  optionalDeps: [
    MODULE.content,
    MODULE.world,
    MODULE.combat,
    MODULE.items,
    MODULE.progression,
    MODULE.auto,
  ],
  data: definePartyContent,
  dataUpdates: patchPartyContent,
  systems: partySystems,
  actions: partyActions,
});
