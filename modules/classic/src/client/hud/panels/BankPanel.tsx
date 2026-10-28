/**
 * Panel "bank" (wave C, docs/design/wave-C.md §2.5 and §10.4). OWNER: T-classic-ui.
 *
 * Hero <-> account: gold to coin (5 % fee, min 1, a sink), items from the bag or
 * the stash into the vault, and withdrawals through the shared VaultView (its
 * `bank` prop calls api.bank.run). Every op goes through api.bank.run, which
 * pauses the local sim and waits for the server (the BankView says when that is
 * not possible: town, offline, busy, local).
 *
 * The result of the last op is shown in the panel (role "status"), not as a toast:
 * the HUD has no toast API for panels.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PlatformServices } from "@gamez/ui-host";
import { VaultView, type VaultViewProps } from "@gamez/ui-host/economy";
import type { BankOp, BankResult } from "@gamez/protocol";
import type { BankClient, BankView, ItemView, Store } from "../../contract.ts";
import { bankFee } from "../../../platform/bank.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Section, type SlotProps } from "../common.tsx";
import { fmtInt, rarityHex } from "../format.ts";
import { C, labelStyle } from "../styles.ts";
import { BANK_KEY } from "../shell.ts";

/** Note shown instead of the actions (null = the bank works now). */
export interface BankNote {
  /** Why: no bank at all, local play, town, socket down or an op in flight. */
  kind: "absent" | "local" | "town" | "offline" | "busy";
  title: string;
  body: string;
}

/** The note for the current bank state (pure). `hasBank` = api.bank is present. */
export function bankNote(hasBank: boolean, blocked: BankView["blocked"] | null): BankNote | null {
  if (!hasBank) {
    return {
      kind: "absent",
      title: "The bank needs the online game",
      body: "Play online to use the bank.",
    };
  }
  switch (blocked) {
    case null:
      return null;
    case "local":
      return {
        kind: "local",
        title: "The bank needs the online game",
        body: "Play online to use the bank.",
      };
    case "town":
      return {
        kind: "town",
        title: "Walk to town to use the bank",
        body: "Your hero must stand in town for a bank trip.",
      };
    case "offline":
      return {
        kind: "offline",
        title: "Reconnecting…",
        body: "The bank opens when the server is back.",
      };
    case "busy":
      return { kind: "busy", title: "Working…", body: "Another bank trip is still running." };
  }
}

/** A gold amount typed by the player: whole part of the text, NaN -> 0. */
export function parseGold(text: string): number {
  const n = Math.trunc(Number(text.trim()));
  return Number.isFinite(n) ? n : 0;
}

/** The deposit preview for `gold` (pure): fee, the coin credited and why it is not possible. */
export function depositPreview(
  gold: number,
  heroGold: number,
): { ok: true; fee: number; coin: number } | { ok: false; reason: string } {
  if (!Number.isSafeInteger(gold) || gold < 1)
    return { ok: false, reason: "Enter at least 1 gold." };
  if (gold > heroGold) return { ok: false, reason: `You carry ${fmtInt(heroGold)} gold.` };
  const fee = bankFee(gold);
  return { ok: true, fee, coin: gold - fee };
}

/** Player-facing text of a finished bank op (pure). */
export function bankOutcome(op: BankOp, r: BankResult): { ok: boolean; message: string } {
  if (!r.ok) return { ok: false, message: r.message || `The bank refused (${r.code}).` };
  switch (op.kind) {
    case "depositGold":
      return {
        ok: true,
        message: `Deposited ${fmtInt(op.gold)} gold: ${fmtInt(r.coin ?? 0)} coin added. Balance ${fmtInt(r.balance)} coin.`,
      };
    case "withdrawCoin":
      return {
        ok: true,
        message: `Withdrew ${fmtInt(r.gold ?? 0)} gold. Balance ${fmtInt(r.balance)} coin.`,
      };
    case "depositItem":
      return { ok: true, message: `Sent ${r.item?.summary.name ?? "the item"} to the vault.` };
    case "withdrawItem":
      return { ok: true, message: `Took ${r.item?.summary.name ?? "the item"} from the vault.` };
  }
}

/** Runs one op and maps the answer to the panel line (never throws). Shared by the buttons and the vault. */
export async function runBankOp(
  bank: Pick<BankClient, "run">,
  op: BankOp,
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await bank.run(op);
    return bankOutcome(op, r);
  } catch {
    return { ok: false, message: "The bank could not be reached." };
  }
}

/** The vault's bank prop: withdrawals through api.bank.run (the panel's note, if any, is the blocked text). */
export function vaultBankProps(
  bank: Pick<BankClient, "run">,
  blocked: string | null,
): NonNullable<VaultViewProps["bank"]> {
  return {
    blocked,
    withdrawItem: async (uid) => {
      const r = await runBankOp(bank, { kind: "withdrawItem", uid });
      return { ok: r.ok, message: r.message };
    },
    withdrawCoin: async (coin) => {
      const r = await runBankOp(bank, { kind: "withdrawCoin", coin });
      return { ok: r.ok, message: r.message };
    },
  };
}

/** A bank view with nothing wrong: used when api.bank is absent (the panel shows the note). */
const ABSENT_VIEW: BankView = { blocked: "local", last: null };
const ABSENT_STORE: Store<BankView> = {
  getSnapshot: () => ABSENT_VIEW,
  subscribe: () => () => {},
};

const spinner: CSSProperties = {
  display: "inline-block",
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: `2px solid ${C.faint}`,
  borderTopColor: C.goldBright,
  animation: "cl-bank-spin 0.9s linear infinite",
  verticalAlign: "middle",
};

function ItemRow({
  item,
  disabled,
  onSend,
}: {
  item: ItemView;
  disabled: boolean;
  onSend: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        borderBottom: `1px dashed ${C.faint}`,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ color: rarityHex(item.rarity), fontWeight: 600 }}>{item.name}</div>
        <div style={labelStyle}>{item.lines.join(" · ")}</div>
      </div>
      <Btn label={`Send ${item.name} to the vault`} disabled={disabled} onClick={onSend}>
        Send to vault
      </Btn>
    </div>
  );
}

export function BankPanel({ api }: SlotProps) {
  const bank = api.bank;
  const view = useSelect<BankView, BankView>(bank?.view ?? ABSENT_STORE, (v) => v);
  const heroGold = useSelect(api.hud, (s) => s.hero?.gold ?? 0);
  const stash = useSelect(api.hud, (s) => s.stash);
  const bag = useSelect(api.hud, (s) => s.inventory.items.map((p) => p.item));
  const platform: PlatformServices | null = api.platform ?? null;
  const [goldText, setGoldText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Bumped after each op of this panel: remounts the VaultView so its list and balance reload.
  const [vaultRev, setVaultRev] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const note = bankNote(bank !== undefined, view.blocked);
  const blocked = note !== null || pending;
  const gold = parseGold(goldText);
  const preview = depositPreview(gold, heroGold);

  const send = (op: BankOp): void => {
    if (!bank || blocked) return;
    setPending(true);
    void runBankOp(bank, op).then((res) => {
      if (!alive.current) return;
      setPending(false);
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) setVaultRev((n) => n + 1);
      if (res.ok && op.kind === "depositGold") setGoldText("");
    });
  };

  const vault = platform?.vault;
  const account = platform?.account;

  return (
    <PanelFrame
      api={api}
      id="bank"
      title="Bank"
      width={460}
      subtitle={`Hero ⇄ account · gold to coin costs 5 % (min 1) · key ${BANK_KEY}`}
    >
      <style>{`@keyframes cl-bank-spin { to { transform: rotate(360deg); } }`}</style>
      {note ? (
        <div role="note" style={{ marginBottom: 8 }}>
          <div style={{ color: C.goldBright, fontWeight: 700 }}>
            {note.kind === "busy" || note.kind === "offline" ? (
              <span role="status" aria-label={note.title} style={spinner} />
            ) : null}
            {note.kind === "busy" || note.kind === "offline" ? " " : null}
            {note.title}
          </div>
          <div style={labelStyle}>{note.body}</div>
        </div>
      ) : null}

      <Section title="Gold to coin">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, flex: "1 1 180px" }}>
            Gold to deposit
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label="Gold to deposit"
              value={goldText}
              disabled={blocked}
              onChange={(e) => setGoldText(e.target.value)}
              style={{ display: "block", width: "100%", minHeight: 44, marginTop: 4 }}
            />
          </label>
          <Btn
            label="Deposit gold"
            disabled={blocked || !preview.ok}
            onClick={() => {
              if (preview.ok) send({ kind: "depositGold", gold });
            }}
          >
            Deposit
          </Btn>
        </div>
        <p style={labelStyle} aria-live="polite">
          {preview.ok
            ? `Fee ${fmtInt(preview.fee)} gold. The account gets ${fmtInt(preview.coin)} coin. You carry ${fmtInt(heroGold)} gold.`
            : gold > 0 || goldText !== ""
              ? preview.reason
              : `You carry ${fmtInt(heroGold)} gold. Withdraw coin below.`}
        </p>
      </Section>

      <Section title="Items to the vault">
        {bag.length === 0 && stash.length === 0 ? (
          <p style={labelStyle}>Nothing to send. Your bag and stash are empty.</p>
        ) : null}
        {bag.map((item) => (
          <ItemRow
            key={`bag-${item.uid}`}
            item={item}
            disabled={blocked}
            onSend={() => send({ kind: "depositItem", ref: item.uid })}
          />
        ))}
        {stash.map((item) => (
          <ItemRow
            key={`stash-${item.uid}`}
            item={item}
            disabled={blocked}
            onSend={() => send({ kind: "depositItem", ref: item.uid })}
          />
        ))}
      </Section>

      <Section title="Vault">
        {vault && account ? (
          <VaultView
            key={vaultRev}
            vault={vault}
            account={account}
            bank={bank ? vaultBankProps(bank, note ? note.title : null) : undefined}
          />
        ) : (
          <p style={labelStyle}>The vault needs the online game.</p>
        )}
      </Section>

      <div role="status" aria-live="polite" style={{ marginTop: 10, minHeight: 20 }}>
        {pending ? <span style={spinner} aria-label="Working" /> : null}
        {pending && message ? " " : null}
        {message ? (
          <span style={{ color: message.ok ? C.ok : C.danger }}>{message.text}</span>
        ) : null}
      </div>
    </PanelFrame>
  );
}
