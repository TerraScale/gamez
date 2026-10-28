/**
 * Onboarding tips, step 2: the text of every tip (original copy, player-facing). Order here is the
 * order they are shown in when several are due: the first due tip that was not dismissed wins.
 */
export const TIP_IDS = [
  "welcome",
  "skillPoint",
  "talentPoint",
  "town",
  "wornGear",
  "setOrUnique",
  "bagFull",
  "boss",
  "rift",
  "idleSpeed",
] as const;

export type TipId = (typeof TIP_IDS)[number];

export interface TipText {
  id: TipId;
  title: string;
  body: string;
}

export const TIPS: Readonly<Record<TipId, TipText>> = {
  welcome: {
    id: "welcome",
    title: "Welcome to the depths",
    body: "Tap or click the ground to move and attack. Auto plays the hero for you, and Idle also runs town trips.",
  },
  skillPoint: {
    id: "skillPoint",
    title: "Skill point",
    body: "Open Skills (S) to learn a skill, then place it on the bar for keys 1 to 6.",
  },
  talentPoint: {
    id: "talentPoint",
    title: "Talent point",
    body: "Open Talents (N) to spend it on a passive or a boost for one of your skills.",
  },
  town: {
    id: "town",
    title: "Town services",
    body: "The smith repairs, upgrades and sockets gear. The gambler sells random items. The stash keeps items in tabs.",
  },
  wornGear: {
    id: "wornGear",
    title: "Worn gear",
    body: "Gear wears down with kills and deaths. Broken gear adds no stats until the smith repairs it.",
  },
  setOrUnique: {
    id: "setOrUnique",
    title: "Set and unique items",
    body: "Wear two or more pieces of one set for its bonus. Uniques have fixed powers.",
  },
  bagFull: {
    id: "bagFull",
    title: "Bag full",
    body: "Sell junk to the junk buyer, or move items to the stash in town.",
  },
  boss: {
    id: "boss",
    title: "Boss on this level",
    body: "Red shapes on the ground are telegraphs. Step out of them before they land.",
  },
  rift: {
    id: "rift",
    title: "The Rift is open",
    body: "The obelisk in town starts an endless run with a score. Each level is harder.",
  },
  idleSpeed: {
    id: "idleSpeed",
    title: "Faster Idle",
    body: "Idle runs at x1. Use the speed buttons in the control bar to run x2 to x8.",
  },
};
