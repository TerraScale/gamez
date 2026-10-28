/** Onboarding tips (docs/design/wave-A.md §10.3): facts, catalogue, trigger rules and the remembered store. */
export { tipFacts, type TipFacts } from "./facts.ts";
export { TIP_IDS, TIPS, type TipId, type TipText } from "./catalog.ts";
export { pickTip, type TipContext } from "./rules.ts";
export {
  TIPS_STORAGE_KEY,
  createTipsStore,
  parseDismissed,
  tipsStore,
  type TipStorage,
  type TipsStore,
} from "./store.ts";
