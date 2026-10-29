/**
 * Feature flags read path (wave-C.md §9.2). CONTRACT (architect, implemented):
 * per-isolate cache of ConfigDO("global").config() for FLAGS_TTL_MS; when the
 * ConfigDO fails, DEFAULT_FLAGS (everything on) — a broken config must not
 * take the game down. T-admin implements the ConfigDO; routes only call this.
 */
import { TUNABLES, type ConfigResponse, type FeatureFlag } from "@gamez/protocol";
import type { Env } from "../contracts.ts";

export const FLAGS_TTL_MS = 10_000;

export const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  bank: true,
  market: true,
  trade: true,
  shops: true,
  arena: true,
  pass: true,
  store: true,
};

let cache: { at: number; config: ConfigResponse } | null = null;

export async function currentConfig(env: Pick<Env, "CONFIG">): Promise<ConfigResponse | null> {
  const now = Date.now();
  if (cache && now - cache.at < FLAGS_TTL_MS) return cache.config;
  try {
    const config = await env.CONFIG.getByName("global").config();
    cache = { at: now, config };
    return config;
  } catch (err) {
    console.error("config: ConfigDO unavailable, using defaults", err);
    return null;
  }
}

export async function featureEnabled(
  env: Partial<Pick<Env, "CONFIG">>,
  flag: FeatureFlag,
): Promise<boolean> {
  if (!env.CONFIG) return DEFAULT_FLAGS[flag];
  const config = await currentConfig(env as Pick<Env, "CONFIG">);
  return config ? config.flags[flag] !== false : DEFAULT_FLAGS[flag];
}

/** Drops the cache (tests, and ConfigDO writes in the same isolate). */
export function resetFlagsCache(): void {
  cache = null;
}

/**
 * Admin dashboard: the current value of a numeric tunable (TUNABLES), clamped
 * to its spec. Reads ConfigResponse.tunables through the same 10 s cache;
 * the spec default when ConfigDO is unreachable, the key is unset or unknown
 * (unknown keys answer NaN so a typo is loud in tests).
 */
export async function tunableValue(
  env: Partial<Pick<Env, "CONFIG">>,
  key: string,
): Promise<number> {
  const spec = TUNABLES.find((t) => t.key === key);
  if (!spec) return Number.NaN;
  if (!env.CONFIG) return spec.default;
  const config = await currentConfig(env as Pick<Env, "CONFIG">);
  const raw = config?.tunables?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, raw));
}
