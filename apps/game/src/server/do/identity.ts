/**
 * IdentityDO (wave-B.md §3.2): owner of one login ("email:<addr>",
 * "google:<sub>", "discord:<id>", "apple:<sub>"), its password hash (email)
 * and failed-attempt lockout. OWNER: T-auth. The logic lives in
 * auth/identity-store.ts; this class only adapts storage and RPC.
 */
import { DurableObject } from "cloudflare:workers";
import { IdentityStore } from "../auth/identity-store.ts";
import {
  sqlStoreOf,
  type Env,
  type IdentityApi,
  type IdentityRecord,
  type PasswordCheck,
} from "../contracts.ts";

export class IdentityDO extends DurableObject<Env> implements IdentityApi {
  readonly #store: IdentityStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new IdentityStore(sqlStoreOf(ctx.storage));
  }

  async get(): Promise<IdentityRecord | null> {
    return this.#store.get();
  }

  async claim(input: Parameters<IdentityApi["claim"]>[0]): Promise<{
    record: IdentityRecord;
    created: boolean;
  }> {
    return this.#store.claim(input);
  }

  async checkPassword(password: string): Promise<PasswordCheck> {
    return this.#store.checkPassword(password);
  }
}
