/** Shared setup for the trade tests: a TradeEscrow over FakeGateway with a fake clock and alarm. */
import type { VaultItem } from "@gamez/protocol";
import { expect } from "vite-plus/test";
import type { SqlStore } from "../../src/server/contracts.ts";
import { TradeEscrow, type TradeState } from "../../src/server/trade/escrow.ts";
import { FakeGateway, testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

export const T0 = 1_700_000_000_000;
export const TRADE_ID = "t0123456789abcdef01234567";
export const A = { accountId: "alice", displayName: "Alice" };
export const B = { accountId: "bob", displayName: "Bob" };

export interface Harness {
  gw: FakeGateway;
  store: SqlStore;
  escrow: TradeEscrow;
  clock: { now: number };
  alarm: { at: number | null };
  /** A new TradeEscrow over the same storage (the DO was evicted / crashed). */
  restart(): TradeEscrow;
  /** Fires the alarm on the current escrow (advancing the clock to it). */
  fire(): Promise<void>;
}

export function harness(): Harness {
  const gw = new FakeGateway(() => clock.now);
  const store = fakeSqlStore();
  const clock = { now: T0 };
  const alarm: { at: number | null } = { at: null };
  const make = () => {
    const e = new TradeEscrow(store, gw, {
      now: () => clock.now,
      setAlarm: (at) => {
        alarm.at = at;
      },
    });
    e.init();
    return e;
  };
  const h: Harness = {
    gw,
    store,
    escrow: make(),
    clock,
    alarm,
    restart() {
      h.escrow = make();
      return h.escrow;
    },
    async fire() {
      if (alarm.at !== null && alarm.at > clock.now) clock.now = alarm.at;
      await h.escrow.alarm();
    },
  };
  return h;
}

/** Identity of an item for conservation checks (uids change when items move). */
export function itemKey(i: Pick<VaultItem, "itemId" | "data" | "count">): string {
  return `${i.itemId}|${i.data}|${i.count}`;
}

export interface Snapshot {
  coin: number;
  items: string[];
}

/**
 * Coin in both wallets + coin burnt (sink ledger) + coin in custody, and the
 * multiset of items in both vaults + custody. Must never change.
 */
export function conserved(h: Harness): Snapshot {
  const ids = [A.accountId, B.accountId];
  const st = h.escrow.state();
  let custodyCoin = 0;
  const custodyItems: string[] = [];
  if (st?.saga) {
    for (const s of st.saga.custody) {
      if (s.state !== "done") continue;
      if (s.kind === "coin") custodyCoin += -(s.amount ?? 0);
      if (s.kind === "take" && s.item) custodyItems.push(itemKey(s.item));
    }
    for (const s of [...st.saga.compensation, ...st.saga.delivery]) {
      if (s.state !== "done") continue;
      if (s.kind === "refund" || s.kind === "recv") custodyCoin -= s.amount ?? 0;
      if ((s.kind === "return" || s.kind === "give") && s.item) {
        const k = itemKey(s.item);
        const i = custodyItems.indexOf(k);
        if (i >= 0) custodyItems.splice(i, 1);
        else custodyItems.push(`NEGATIVE:${k}`);
      }
    }
  }
  const items = [...ids.flatMap((id) => h.gw.vault(id).map(itemKey)), ...custodyItems].sort();
  return { coin: h.gw.totalCoin(ids) + h.gw.sunk(ids) + custodyCoin, items };
}

/** Seeds A with 1000 coin and two items, B with 500 coin and one item. */
export function seedStandard(h: Harness): { a: VaultItem[]; b: VaultItem[] } {
  h.gw.register(A.accountId, A.displayName);
  h.gw.register(B.accountId, B.displayName);
  const a = h.gw.seed(A.accountId, { coin: 1000, items: [testItem("sword"), testItem("ring")] });
  const b = h.gw.seed(B.accountId, { coin: 500, items: [testItem("shield")] });
  return { a, b };
}

/** Opens the standard trade (A: 100 coin + both items; B: 50 coin + shield), not yet accepted. */
export async function openStandard(h: Harness): Promise<{ a: VaultItem[]; b: VaultItem[] }> {
  const seeded = seedStandard(h);
  expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
  expectOk(
    await h.escrow.offer({
      accountId: A.accountId,
      coin: 100,
      uids: seeded.a.map((i) => i.uid),
    }),
  );
  expectOk(
    await h.escrow.offer({ accountId: B.accountId, coin: 50, uids: seeded.b.map((i) => i.uid) }),
  );
  return seeded;
}

/** Both sides accept the current versions. */
export async function acceptBoth(h: Harness): Promise<void> {
  const st = h.escrow.state()!;
  const v: [number, number] = [st.offers.a.version, st.offers.b.version];
  expectOk(await h.escrow.accept({ accountId: A.accountId, versions: v }));
  await h.escrow.accept({ accountId: B.accountId, versions: v });
}

export function expectOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) expect.fail(`expected ok, got ${r.code}`);
  return (r as { ok: true; value: T }).value;
}

/** Runs the alarm until the trade is terminal and no task is pending (max 20 rounds). */
export async function settle(h: Harness): Promise<TradeState> {
  for (let i = 0; i < 20; i++) {
    const st = h.escrow.state()!;
    if (st.status !== "committing" && st.status !== "open" && st.tasks.every((t) => t.done))
      return st;
    await h.fire();
  }
  return h.escrow.state()!;
}
