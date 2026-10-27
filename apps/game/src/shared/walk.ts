/**
 * Walk maths now live in @gamez/world (packages/world/src/walk.ts). This module
 * re-exports them so existing imports in the server and client keep working.
 */
export {
  MAX_PATH_STEPS,
  planWalk,
  walkAt,
  walkEnd,
  type PlanResult,
  type Walk,
  type WalkPoint,
} from "@gamez/world";
