/**
 * Status kinds (design §7.3). Durations and powers live on the skill or mod
 * that applies them; these prototypes define the behaviour and the look.
 */
import type { StatusProto } from "../types.ts";

export const STATUSES: Record<string, StatusProto> = {
  "classic.status.chill": {
    name: "Chilled",
    kind: "slow",
    stacks: false,
    icon: "icon.status.chill",
    tint: 0x7fd4ff,
  },
  "classic.status.stun": {
    name: "Stunned",
    kind: "stun",
    stacks: false,
    icon: "icon.status.stun",
    tint: 0xffe066,
  },
  "classic.status.poison": {
    name: "Poisoned",
    kind: "dot",
    element: "poison",
    every: 10,
    stacks: false,
    icon: "icon.status.poison",
    tint: 0x7cff5c,
  },
  "classic.status.burn": {
    name: "Burning",
    kind: "dot",
    element: "fire",
    every: 10,
    stacks: false,
    icon: "icon.status.burn",
    tint: 0xff8a3d,
  },
  "classic.status.rally": {
    name: "Rallied",
    kind: "buff",
    mods: [
      { stat: "dmgPct", perPower: 1 },
      { stat: "armorPct", perPower: 1 },
    ],
    stacks: false,
    icon: "icon.status.rally",
    tint: 0xffd27a,
  },
  "classic.status.iron_skin": {
    name: "Iron Skinned",
    kind: "buff",
    mods: [
      { stat: "armorPct", perPower: 2 },
      { stat: "resAll", perPower: 1 },
    ],
    stacks: false,
    icon: "icon.status.iron_skin",
    tint: 0xb8c4d0,
  },
};
