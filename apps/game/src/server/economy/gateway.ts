/**
 * AccountGateway over env.ACCOUNT (wave-C.md §3.1). CONTRACT (architect,
 * implemented). Every wave C DO talks to accounts only through this, so its
 * logic class can be tested with an in-memory fake (economy/fake-gateway.ts in tests).
 */
import type { AccountGateway, Env } from "../contracts.ts";

export function accountGateway(env: Pick<Env, "ACCOUNT">): AccountGateway {
  const acct = (id: string) => env.ACCOUNT.getByName(id);
  return {
    wallet: (id) => acct(id).wallet(),
    walletTx: (id, tx) => acct(id).walletTx(tx),
    vaultGet: (id, uid) => acct(id).vaultGet(uid),
    vaultTake: (id, txId, uid) => acct(id).vaultTake(txId, uid),
    vaultPut: (id, txId, item) => acct(id).vaultPut(txId, item),
    notify: (id, notice) => acct(id).notify(notice),
    addSeasonXp: async (id, txId, xp, reason) => {
      await acct(id).addSeasonXp(txId, xp, reason);
    },
  };
}
