/**
 * EscrowDO (wave-C.md §3.3): one direct trade between two accounts, named by
 * the tradeId ("t" + 24 hex). OWNER: T-escrow. An adapter only: the saga lives
 * in trade/escrow.ts (TradeEscrow over SqlStore + AccountGateway + clock).
 */
import type { Party } from "@gamez/protocol";
import { DurableObject } from "cloudflare:workers";
import { sqlStoreOf, type EscrowApi, type Env } from "../contracts.ts";
import { accountGateway } from "../economy/gateway.ts";
import { TradeEscrow, type TradeAccounts } from "../trade/escrow.ts";

export class EscrowDO extends DurableObject<Env> implements EscrowApi {
  readonly #escrow: TradeEscrow;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const accounts: TradeAccounts = {
      ...accountGateway(env),
      linkTrade: (accountId, tradeId, open) =>
        env.ACCOUNT.getByName(accountId).linkTrade(tradeId, open),
    };
    this.#escrow = new TradeEscrow(sqlStoreOf(ctx.storage), accounts, {
      now: Date.now,
      setAlarm: async (at) => {
        if (at === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(Math.max(at, Date.now()));
      },
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#escrow.init();
    });
  }

  async alarm(): Promise<void> {
    await this.#escrow.alarm();
  }

  async open(input: { tradeId: string; a: Party; b: Party }) {
    return this.#escrow.open(input);
  }
  async view(accountId: string) {
    return this.#escrow.view(accountId);
  }
  async offer(input: { accountId: string; coin: number; uids: string[] }) {
    return this.#escrow.offer(input);
  }
  async accept(input: { accountId: string; versions: [number, number] }) {
    return this.#escrow.accept(input);
  }
  async cancel(accountId: string) {
    return this.#escrow.cancel(accountId);
  }
}
