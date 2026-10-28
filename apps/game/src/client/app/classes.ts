/**
 * Class filters of the leaderboards. Static on purpose: loading the classic
 * registry (loadMode) just for three names would pull the whole mode into the shell.
 */
export const SOCIAL_CLASSES: readonly { id: string; name: string }[] = [
  { id: "classic.warrior", name: "Warrior" },
  { id: "classic.rogue", name: "Rogue" },
  { id: "classic.sorcerer", name: "Sorcerer" },
];
