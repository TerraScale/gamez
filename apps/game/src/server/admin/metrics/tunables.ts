/**
 * GET/POST /api/admin/tunables (docs/design/admin-dashboard.md §8). OWNER: T-api-tech.
 * Validation (unknown key / non-number / out of range / empty patch -> 400, naming
 * the key) happens in `parseTunablesPatch`; the write goes to ConfigDO "global"
 * (the route resets the flags cache and the metrics cache after it).
 */
import { TUNABLES, type TunablesResponse } from "@gamez/protocol";
import type { Env } from "../../contracts.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The patch, or an error message for a 400. */
export function parseTunablesPatch(body: unknown): Record<string, number> | string {
  if (!isPlainObject(body) || !isPlainObject(body.values)) {
    return "body must be {values: {key: number}}";
  }
  const entries = Object.entries(body.values);
  if (entries.length === 0) return "values: at least one tunable is required";
  const out: Record<string, number> = {};
  for (const [key, raw] of entries) {
    const spec = TUNABLES.find((t) => t.key === key);
    if (!spec) return `unknown tunable "${key}"`;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return `${key}: must be a finite number`;
    }
    if (raw < spec.min || raw > spec.max) {
      return `${key}: must be between ${spec.min} and ${spec.max}`;
    }
    out[key] = raw;
  }
  return out;
}

export async function readTunables(env: Pick<Env, "CONFIG">): Promise<TunablesResponse> {
  return env.CONFIG.getByName("global").tunables();
}

export async function writeTunables(
  env: Pick<Env, "CONFIG">,
  patch: Record<string, number>,
  by: string,
): Promise<TunablesResponse> {
  return env.CONFIG.getByName("global").setTunables(patch, by);
}
