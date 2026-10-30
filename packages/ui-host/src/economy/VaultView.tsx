/**
 * The account vault: items, coin and gem balances, and (with a `bank`, from the
 * classic HUD) withdrawals back to the hero. Mobile first; states loading,
 * empty, error and data. Presentational body exported for tests.
 */
import { useState } from "react";
import { marketEligible } from "./parts/fees.ts";
import { type LoadState, bankResult, checkCoinWithdraw, loadResult } from "./parts/flows.ts";
import { useAction, useReload } from "./parts/hooks.ts";
import { Banner, Field, ItemRow, StateNote, actionsStyle } from "./parts/ui.tsx";
import type { VaultItem, VaultResponse, WalletView } from "@gamez/protocol";
import type { VaultViewProps } from "./index.ts";
import type { ApiResult } from "../platform.ts";
import {
  badgeStyle,
  headingStyle,
  inputStyle,
  mutedStyle,
  sheetStyle,
  socialButtonStyle,
} from "../social/styles.ts";
import { formatCoin, vaultWaitingText } from "./parts/text.ts";

export interface VaultBodyProps {
  /** undefined while loading. */
  vault: LoadState<VaultResponse> | undefined;
  wallet: LoadState<WalletView> | undefined;
  bank?: VaultViewProps["bank"];
  onSell?: VaultViewProps["onSell"];
  busy: boolean;
  error: string | null;
  coinText: string;
  onCoinText: (text: string) => void;
  onWithdrawCoin: () => void;
  onWithdrawItem: (uid: string) => void;
  onRetry: () => void;
  compact?: boolean;
}

/** Coin and gem chips; "—" while the wallet is not known. */
function Balances({ wallet }: { wallet: LoadState<WalletView> | undefined }) {
  const ready = wallet?.status === "ready" ? wallet.value.balances : null;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <span style={badgeStyle} aria-label="Coin balance">
        {ready ? formatCoin(ready.coin) : "coin —"}
      </span>
      <span style={badgeStyle} aria-label="Gem balance">
        {ready ? `${ready.gem.toLocaleString("en-US")} gems` : "gems —"}
      </span>
    </span>
  );
}

export function VaultBody({
  vault,
  wallet,
  bank,
  onSell,
  busy,
  error,
  coinText,
  onCoinText,
  onWithdrawCoin,
  onWithdrawItem,
  onRetry,
  compact = false,
}: VaultBodyProps) {
  const blocked = bank?.blocked ?? null;
  const coinBalance = wallet?.status === "ready" ? wallet.value.balances.coin : null;
  const items: readonly VaultItem[] = vault?.status === "ready" ? vault.value.items : [];
  const max = vault?.status === "ready" ? vault.value.max : null;
  const waiting = vault?.status === "ready" ? vaultWaitingText(vault.value.waiting) : null;

  return (
    <section aria-label="Vault" style={{ ...sheetStyle, padding: compact ? 8 : 12 }}>
      <div style={actionsStyle}>
        <h3 style={headingStyle}>Vault</h3>
        {max !== null ? <span style={mutedStyle}>{`${items.length} / ${max} items`}</span> : null}
      </div>
      <Balances wallet={wallet} />

      {error ? <Banner tone="error">{error}</Banner> : null}
      {waiting ? <Banner tone="info">{waiting}</Banner> : null}
      {bank && blocked ? <Banner tone="info">{blocked}</Banner> : null}

      {bank ? (
        <form
          aria-label="Withdraw coin"
          style={actionsStyle}
          onSubmit={(e) => {
            e.preventDefault();
            onWithdrawCoin();
          }}
        >
          <Field label="Coin to withdraw to the hero as gold" hint="Gold comes out 1 to 1.">
            <input
              inputMode="numeric"
              value={coinText}
              disabled={busy || blocked !== null}
              onChange={(e) => onCoinText(e.target.value)}
              style={inputStyle}
              placeholder="0"
            />
          </Field>
          <button
            type="submit"
            disabled={busy || blocked !== null || coinBalance === null}
            style={socialButtonStyle({
              disabled: busy || blocked !== null || coinBalance === null,
            })}
          >
            Withdraw coin
          </button>
        </form>
      ) : null}

      {vault === undefined || vault.status === "loading" ? (
        <StateNote kind="loading" message="Loading your vault…" />
      ) : vault.status === "error" ? (
        <StateNote kind="error" message={vault.message} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <StateNote
          kind="empty"
          message={
            bank
              ? "Your vault is empty. Deposit items at the bank in town."
              : "Your vault is empty."
          }
        />
      ) : (
        <ul
          aria-label="Vault items"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 0,
          }}
        >
          {items.map((item) => {
            const sellable = !!onSell && item.tradable && marketEligible(item.summary);
            return (
              <ItemRow key={item.uid} item={item} label={item.summary.name}>
                {!item.tradable ? <span style={mutedStyle}>Not tradable</span> : null}
                {bank ? (
                  <button
                    type="button"
                    aria-label={`Withdraw ${item.summary.name}`}
                    disabled={busy || blocked !== null}
                    onClick={() => onWithdrawItem(item.uid)}
                    style={socialButtonStyle({ disabled: busy || blocked !== null })}
                  >
                    Withdraw
                  </button>
                ) : null}
                {sellable ? (
                  <button
                    type="button"
                    aria-label={`Sell ${item.summary.name} on the market`}
                    disabled={busy}
                    onClick={() => onSell?.(item.uid)}
                    style={socialButtonStyle({ disabled: busy })}
                  >
                    Sell
                  </button>
                ) : null}
              </ItemRow>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function VaultView({ vault, account, bank, onSell, compact = false }: VaultViewProps) {
  const items = useReload(() => loadResult(() => vault.vault()), "vault");
  const wallet = useReload(() => loadResult(() => account.wallet()), "wallet");
  const action = useAction();
  const [coinText, setCoinText] = useState("");
  const coinBalance = wallet.state?.status === "ready" ? wallet.state.value.balances.coin : null;

  const refreshAll = () => {
    items.reload();
    wallet.reload();
  };

  const withdrawItem = (uid: string) => {
    if (!bank) return;
    void action
      .run(() => bankResult(() => bank.withdrawItem(uid)))
      .then((res) => {
        if (res.ok) refreshAll();
      });
  };

  const withdrawCoin = () => {
    if (!bank || coinBalance === null) return;
    void action
      .run((): Promise<ApiResult<null>> => {
        const check = checkCoinWithdraw(coinText, coinBalance);
        if (!check.ok)
          return Promise.resolve({ ok: false, code: "bad_request", message: check.message });
        return bankResult(() => bank.withdrawCoin(check.coin));
      })
      .then((res) => {
        if (res.ok) {
          setCoinText("");
          refreshAll();
        }
      });
  };

  return (
    <VaultBody
      vault={items.state}
      wallet={wallet.state}
      bank={bank}
      onSell={onSell}
      busy={action.busy}
      error={action.error}
      coinText={coinText}
      onCoinText={setCoinText}
      onWithdrawCoin={withdrawCoin}
      onWithdrawItem={withdrawItem}
      onRetry={refreshAll}
      compact={compact}
    />
  );
}
