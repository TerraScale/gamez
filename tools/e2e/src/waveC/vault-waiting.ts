/**
 * Wave C e2e: a delivery into a full vault waits in custody and the player is
 * told (ADR 0006 §13). B fills the vault to VAULT_MAX_ITEMS with dev grants, A
 * trades an item to B, both accept: the trade stays "committing" (the escrow
 * retries the delivery), B's GET /api/account/vault reports one waiting
 * delivery, and B's inbox holds exactly one "vault.full" notice. OWNER: T-escrow.
 */
import {
  VAULT_MAX_ITEMS,
  type NoticesResponse,
  type TradeView,
  type VaultItemInput,
  type VaultResponse,
} from "@gamez/protocol";
import { api, registerGuest } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eFeature } from "../features.ts";
import { check } from "../report.ts";

/** The dev grant takes at most this many items per call (routes/vault.ts). */
const GRANT_BATCH = 20;

function filler(tag: string, i: number): VaultItemInput {
  return {
    itemId: "universal.material.ember_dust",
    origin: "",
    count: 1,
    universal: true,
    tradable: true,
    summary: {
      name: `Ember Dust ${tag}-${i}`,
      rarity: "common",
      level: 0,
      category: "material",
      slot: null,
      icon: "item.ember_dust",
      lines: [],
    },
    data: null,
  };
}

export const vaultWaitingFeature: E2eFeature = {
  name: "vault-waiting",
  async run(ctx) {
    const url = ctx.url;
    const tag = Date.now().toString(36);
    const a = await registerGuest(url, await loginGuest(url), `Giver ${tag.slice(-4)}`);
    const b = await registerGuest(url, await loginGuest(url), `Hoarder ${tag.slice(-4)}`);

    const gift = await api<{ items?: { uid: string }[] }>(url, "/api/dev/economy/grant", {
      token: a.token,
      body: { opId: `e2e-vw-a-${tag}`, items: [filler("gift", 0)] },
    });
    const giftUid = gift.body.items?.[0]?.uid ?? "";
    let filled = 0;
    for (let n = 0; filled < VAULT_MAX_ITEMS; n++) {
      const items = Array.from(
        { length: Math.min(GRANT_BATCH, VAULT_MAX_ITEMS - filled) },
        (_, i) => filler(tag, filled + i),
      );
      const r = await api<unknown>(url, "/api/dev/economy/grant", {
        token: b.token,
        body: { opId: `e2e-vw-b-${tag}-${n}`, items },
      });
      if (r.status !== 200) break;
      filled += items.length;
    }
    const before = (await api<VaultResponse>(url, "/api/account/vault", { token: b.token })).body;
    check(
      giftUid !== "" && before.items.length === VAULT_MAX_ITEMS,
      `vault-waiting: B's vault is full (${before.items.length}/${VAULT_MAX_ITEMS})`,
    );
    check(
      before.waiting?.count === 0,
      `vault-waiting: nothing waits before the trade (${JSON.stringify(before.waiting)})`,
    );

    const opened = await api<TradeView>(url, "/api/trade", {
      token: a.token,
      body: { opId: `e2e-vw-open-${tag}`, with: b.accountId },
    });
    const tradeId = opened.body.id;
    await api<TradeView>(url, `/api/trade/${tradeId}/offer`, {
      token: a.token,
      body: { coin: 0, uids: [giftUid] },
    });
    const offerB = await api<TradeView>(url, `/api/trade/${tradeId}/offer`, {
      token: b.token,
      body: { coin: 0, uids: [] },
    });
    const versions: [number, number] = [
      offerB.body.offers?.a.version ?? -1,
      offerB.body.offers?.b.version ?? -1,
    ];
    await api<TradeView>(url, `/api/trade/${tradeId}/accept`, {
      token: a.token,
      body: { versions },
    });
    const accepted = await api<TradeView>(url, `/api/trade/${tradeId}/accept`, {
      token: b.token,
      body: { versions },
    });
    check(
      accepted.status === 200 && accepted.body.status === "committing",
      `vault-waiting: the trade waits in custody (${accepted.status} ${accepted.body.status} ${accepted.body.reason ?? ""})`,
    );

    const after = (await api<VaultResponse>(url, "/api/account/vault", { token: b.token })).body;
    check(
      after.waiting?.count === 1 && typeof after.waiting.since === "number",
      `vault-waiting: GET /api/account/vault lists one waiting delivery (${JSON.stringify(after.waiting)})`,
    );
    const inbox = (await api<NoticesResponse>(url, "/api/account/notices", { token: b.token }))
      .body;
    const full = inbox.notices.filter((n) => n.kind === "vault.full");
    check(
      full.length === 1 && full[0]!.text.includes("vault is full"),
      `vault-waiting: B gets one vault.full notice (${full.length})`,
    );
    const giver = (await api<VaultResponse>(url, "/api/account/vault", { token: a.token })).body;
    check(
      giver.items.length === 0 && giver.waiting?.count === 0,
      "vault-waiting: the giver's item is held in custody, not lost or duplicated",
    );
  },
};
