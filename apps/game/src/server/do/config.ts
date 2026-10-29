/**
 * ConfigDO "global" (wave-C.md §9.2): feature flags (kill switches), numeric
 * tunables (admin-dashboard.md §8), the current season and dev admin grants.
 * OWNER: T-admin (flags) and T-api-tech (tunables). Logic lives in
 * admin/flags-store.ts; this class adapts storage and RPC.
 */
import {
  TUNABLES,
  type ConfigResponse,
  type FeatureFlag,
  type TunablesResponse,
} from "@gamez/protocol";
import { DurableObject } from "cloudflare:workers";
import { FlagsStore } from "../admin/flags-store.ts";
import { sqlStoreOf, type ConfigApi, type Env } from "../contracts.ts";

/** Audit rows returned with the tunables (the store keeps AUDIT_KEEP). */
const TUNABLE_AUDIT_SHOWN = 100;

export class ConfigDO extends DurableObject<Env> implements ConfigApi {
  readonly #flags: FlagsStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#flags = new FlagsStore(sqlStoreOf(ctx.storage));
  }

  async config(): Promise<ConfigResponse> {
    return this.#flags.config();
  }

  async setFlags(
    patch: Partial<Record<FeatureFlag, boolean>>,
    by: string,
  ): Promise<ConfigResponse> {
    this.#flags.setFlags(patch, by);
    return this.#flags.config();
  }

  async tunables(): Promise<TunablesResponse> {
    return this.#tunablesResponse();
  }

  async setTunables(patch: Record<string, number>, by: string): Promise<TunablesResponse> {
    this.#flags.setTunables(patch, by);
    return this.#tunablesResponse();
  }

  #tunablesResponse(): TunablesResponse {
    return {
      values: this.#flags.tunables(),
      specs: TUNABLES,
      audit: this.#flags.tunableAudit(TUNABLE_AUDIT_SHOWN),
    };
  }

  /** Dev admins (not in the ConfigApi contract): granted by POST /api/dev/admin/self on dev hosts. */
  async grantDevAdmin(accountId: string): Promise<void> {
    this.#flags.grantDevAdmin(accountId);
  }

  async isDevAdmin(accountId: string): Promise<boolean> {
    return this.#flags.isDevAdmin(accountId);
  }
}
