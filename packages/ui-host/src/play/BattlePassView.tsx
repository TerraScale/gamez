/**
 * Battle pass (wave-C.md §7, §10.3). OWNER: T-pass.
 * A horizontal tier track: one column per tier, rows for the free and premium
 * tracks, xp progress toward the next tier, a time-left label, claim buttons,
 * and "Get premium" while the premium track is locked. The tier track scrolls
 * sideways inside its own box, so the page itself never scrolls sideways at
 * 375 px. Presentational parts are exported for tests (renderToStaticMarkup).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import type { PassReward, PassTrack, PassView } from "@gamez/protocol";
import type { PassApi } from "../platform.ts";
import type { BattlePassViewProps } from "./index.ts";
import { useLoad } from "../social/hooks.ts";
import {
  SOCIAL_C,
  SOCIAL_FONT,
  SOCIAL_TOUCH,
  badgeStyle,
  errorTextStyle,
  headingStyle,
  mutedStyle,
  okTextStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
} from "../social/styles.ts";

/** Result of the pass load: a view, or the error to show. */
export type PassLoad = { status: "ok"; view: PassView } | { status: "error"; message: string };

/** What a tier cell shows for one track. */
export type TierCellState = "empty" | "claimed" | "claimable" | "premium-locked" | "locked";

const LABEL_COL = 72;
const TIER_COL = 96;

/** Loads the view; never rejects (a failure becomes an error state). */
export async function loadPass(api: PassApi): Promise<PassLoad> {
  try {
    const res = await api.view();
    if (res.ok) return { status: "ok", view: res.value };
    return { status: "error", message: res.message || "Could not load the battle pass." };
  } catch {
    return { status: "error", message: "Could not reach the battle pass." };
  }
}

/** "62 days left", "3 h left", "40 min left", or "Season ended". */
export function timeLeftLabel(endsAt: number, now: number): string {
  const ms = endsAt - now;
  if (!(ms > 0)) return "Season ended";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

/** Short text for one reward. */
export function rewardLabel(reward: PassReward | null): string {
  if (!reward) return "Nothing";
  if (reward.kind === "coin") return `${reward.amount} coin`;
  return reward.name;
}

/** Slot word shown under a cosmetic reward. */
export function rewardSlotLabel(reward: PassReward | null): string {
  if (!reward || reward.kind === "coin") return "";
  if (reward.kind === "title") return "title";
  if (reward.slot === "chatColor") return "chat colour";
  return reward.slot;
}

/** Progress toward the next tier: current tier, xp into it and the bar fraction (0..1). */
export function passProgress(view: PassView): {
  tier: number;
  maxTier: number;
  nextXp: number | null;
  fraction: number;
} {
  const maxTier = view.tiers.reduce((m, t) => Math.max(m, t.tier), 0);
  const tier = Math.min(view.tier, maxTier);
  if (tier >= maxTier) return { tier, maxTier, nextXp: null, fraction: 1 };
  const floor = view.tiers.find((t) => t.tier === tier)?.xp ?? 0;
  const next = view.tiers.find((t) => t.tier === tier + 1);
  const nextXp = next?.xp ?? null;
  if (nextXp === null || nextXp <= floor) return { tier, maxTier, nextXp, fraction: 0 };
  const fraction = Math.min(1, Math.max(0, (view.xp - floor) / (nextXp - floor)));
  return { tier, maxTier, nextXp, fraction };
}

/** The state of one tier cell on one track. */
export function tierCellState(view: PassView, track: PassTrack, tier: number): TierCellState {
  const def = view.tiers.find((t) => t.tier === tier);
  const reward = def ? (track === "free" ? def.free : def.premium) : null;
  if (!reward) return "empty";
  if (view.claimed[track].includes(tier)) return "claimed";
  if (view.tier < tier) return "locked";
  if (track === "premium" && !view.premium) return "premium-locked";
  return "claimable";
}

export interface BattlePassBodyProps {
  /** undefined while loading. */
  state: PassLoad | undefined;
  /** "track:tier" of the claim in flight. */
  busyKey: string | null;
  error: string | null;
  /** Epoch ms for the time-left label. */
  now: number;
  compact?: boolean;
  onClaim: (tier: number, track: PassTrack) => void;
  onBuyPremium?: () => void;
  /**
   * Premium for gems: shown when set. `gems` is the wallet balance (null while
   * unknown); the button is disabled below `price` or while `busy`.
   */
  gemOffer?: { price: number; gems: number | null; busy: boolean };
  onUnlockWithGems?: () => void;
  onRetry: () => void;
}

/** Label and state of the "Unlock for N gems" button. */
export function gemOfferState(offer: { price: number; gems: number | null; busy: boolean }): {
  label: string;
  hint: string;
  disabled: boolean;
} {
  const price = offer.price.toLocaleString("en-US");
  const label = offer.busy ? "Unlocking..." : `Unlock for ${price} gems`;
  if (offer.gems === null) return { label, hint: "", disabled: true };
  const have = `You have ${offer.gems.toLocaleString("en-US")} gems.`;
  if (offer.gems < offer.price) return { label, hint: `${have} Not enough yet.`, disabled: true };
  return { label, hint: have, disabled: offer.busy };
}

export function BattlePassBody({
  state,
  busyKey,
  error,
  now,
  compact = false,
  onClaim,
  onBuyPremium,
  gemOffer,
  onUnlockWithGems,
  onRetry,
}: BattlePassBodyProps) {
  const frame: CSSProperties = { ...sheetStyle, padding: compact ? 8 : 12 };
  if (state === undefined) {
    return (
      <section aria-label="Battle pass" style={frame}>
        <p role="status" style={mutedStyle}>
          Loading the battle pass...
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section aria-label="Battle pass" style={frame}>
        <h2 style={headingStyle}>Battle pass</h2>
        <p role="alert" style={errorTextStyle}>
          {state.message}
        </p>
        <button type="button" onClick={onRetry} style={socialButtonStyle()}>
          Try again
        </button>
      </section>
    );
  }
  const view = state.view;
  if (view.tiers.length === 0) {
    return (
      <section aria-label="Battle pass" style={frame}>
        <h2 style={headingStyle}>{view.name}</h2>
        <p style={mutedStyle}>The rewards for this season are not ready yet.</p>
      </section>
    );
  }

  const progress = passProgress(view);
  const busy = busyKey !== null;
  return (
    <section aria-label="Battle pass" style={frame}>
      <header style={{ ...rowStyle, justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={headingStyle}>{view.name}</h2>
          <p style={mutedStyle}>{timeLeftLabel(view.endsAt, now)}</p>
        </div>
        <span style={badgeStyle}>Tier {progress.tier}</span>
      </header>

      <div aria-label="Season xp" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={mutedStyle}>
          {progress.nextXp === null
            ? `${view.xp} xp, top tier reached`
            : `${view.xp} / ${progress.nextXp} xp to tier ${progress.tier + 1}`}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.fraction * 100)}
          style={{
            height: 8,
            borderRadius: 4,
            background: SOCIAL_C.field,
            border: `1px solid ${SOCIAL_C.border}`,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.round(progress.fraction * 100)}%`,
              height: "100%",
              background: SOCIAL_C.gold,
            }}
          />
        </div>
      </div>

      {!view.premium ? (
        <div style={rowStyle}>
          <button
            type="button"
            onClick={onBuyPremium}
            disabled={!onBuyPremium}
            style={socialButtonStyle({ primary: true, disabled: !onBuyPremium })}
          >
            Get premium
          </button>
          {gemOffer && onUnlockWithGems
            ? (() => {
                const g = gemOfferState(gemOffer);
                return (
                  <>
                    <button
                      type="button"
                      onClick={onUnlockWithGems}
                      disabled={g.disabled || busy}
                      style={socialButtonStyle({ disabled: g.disabled || busy })}
                    >
                      {g.label}
                    </button>
                    {g.hint ? <p style={mutedStyle}>{g.hint}</p> : null}
                  </>
                );
              })()
            : null}
          <p style={mutedStyle}>Premium adds a nameplate, title or colour on every tier.</p>
        </div>
      ) : (
        <p style={okTextStyle}>Premium track unlocked.</p>
      )}

      {error ? (
        <p role="alert" style={errorTextStyle}>
          {error}
        </p>
      ) : null}

      <p style={{ ...mutedStyle, fontSize: 12 }} aria-hidden="true">
        {view.tiers.length} tiers. Scroll sideways for more &rarr;
      </p>
      <div style={{ position: "relative", minWidth: 0 }}>
        <div
          role="region"
          aria-label="Tier track"
          tabIndex={0}
          style={{
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            border: `1px solid ${SOCIAL_C.border}`,
            borderRadius: 8,
            background: SOCIAL_C.inner,
            minWidth: 0,
          }}
        >
          <TrackRow label="Tier">
            {view.tiers.map((t) => (
              <div
                key={t.tier}
                style={{
                  ...cellBox,
                  color: t.tier <= view.tier ? SOCIAL_C.goldBright : SOCIAL_C.muted,
                  fontWeight: 700,
                }}
              >
                <span>{t.tier}</span>
                <span style={{ ...mutedStyle, fontSize: 11 }}>{t.xp} xp</span>
              </div>
            ))}
          </TrackRow>
          <TrackRow label="Free">
            {view.tiers.map((t) => (
              <TierCell
                key={`free-${t.tier}`}
                view={view}
                track="free"
                tier={t.tier}
                busyKey={busyKey}
                busy={busy}
                onClaim={onClaim}
              />
            ))}
          </TrackRow>
          <TrackRow label="Premium">
            {view.tiers.map((t) => (
              <TierCell
                key={`premium-${t.tier}`}
                view={view}
                track="premium"
                tier={t.tier}
                busyKey={busyKey}
                busy={busy}
                onClaim={onClaim}
              />
            ))}
          </TrackRow>
        </div>
        {/* Right-edge fade: the track continues past the card edge. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 1,
            right: 1,
            bottom: 1,
            width: 28,
            borderRadius: "0 8px 8px 0",
            pointerEvents: "none",
            background: `linear-gradient(to right, transparent, ${SOCIAL_C.sheet})`,
          }}
        />
      </div>
    </section>
  );
}

const cellBox: CSSProperties = {
  width: TIER_COL,
  minWidth: TIER_COL,
  flexShrink: 0,
  padding: "6px 6px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 4,
  fontFamily: SOCIAL_FONT,
  fontSize: 12,
  minHeight: SOCIAL_TOUCH,
  borderLeft: `1px solid ${SOCIAL_C.border}`,
};

function TrackRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", minWidth: "max-content" }}>
      <div
        style={{
          width: LABEL_COL,
          minWidth: LABEL_COL,
          flexShrink: 0,
          padding: "6px 8px",
          boxSizing: "border-box",
          color: SOCIAL_C.gold,
          fontWeight: 700,
          fontSize: 12,
          display: "flex",
          alignItems: "center",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function TierCell({
  view,
  track,
  tier,
  busyKey,
  busy,
  onClaim,
}: {
  view: PassView;
  track: PassTrack;
  tier: number;
  busyKey: string | null;
  busy: boolean;
  onClaim: (tier: number, track: PassTrack) => void;
}) {
  const def = view.tiers.find((t) => t.tier === tier);
  const reward = def ? (track === "free" ? def.free : def.premium) : null;
  const state = tierCellState(view, track, tier);
  const key = `${track}:${tier}`;
  const label = rewardLabel(reward);
  const slot = rewardSlotLabel(reward);
  return (
    <div style={cellBox} data-state={state}>
      <span style={{ color: SOCIAL_C.text, overflowWrap: "anywhere", lineHeight: 1.2 }}>
        {label}
      </span>
      {slot ? <span style={{ ...mutedStyle, fontSize: 10 }}>{slot}</span> : null}
      {state === "claimed" ? <span style={okTextStyle}>Claimed</span> : null}
      {state === "locked" ? <span style={mutedStyle}>Locked</span> : null}
      {state === "premium-locked" ? <span style={mutedStyle}>Premium</span> : null}
      {state === "claimable" ? (
        <button
          type="button"
          aria-label={`Claim tier ${tier} ${track}: ${label}`}
          disabled={busy}
          onClick={() => onClaim(tier, track)}
          style={{ ...socialButtonStyle({ primary: true, disabled: busy }), padding: "0 6px" }}
        >
          {busyKey === key ? "Claiming..." : "Claim"}
        </button>
      ) : null}
    </div>
  );
}

export function BattlePassView(props: BattlePassViewProps) {
  const { pass, compact = false } = props;
  const [revision, setRevision] = useState(0);
  const [now] = useState(() => Date.now());
  const loaded = useLoad<PassLoad>(() => loadPass(pass), [pass, revision]);
  const [walletRev, setWalletRev] = useState(0);
  const canGems = !!props.canSpendGems && typeof pass.premium === "function";
  const gemBalance = useLoad<number | null>(
    () =>
      canGems
        ? props.account
            .wallet()
            .then((r) => (r.ok ? r.value.balances.gem : null))
            .catch(() => null)
        : Promise.resolve(null),
    [props.account, canGems, revision, walletRev],
  );
  // A claim answers the whole view; it stands until the next load replaces the base.
  const [claimed, setClaimed] = useState<{ base: PassLoad; view: PassView } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state: PassLoad | undefined =
    loaded && claimed && claimed.base === loaded ? { status: "ok", view: claimed.view } : loaded;

  async function onClaim(tier: number, track: PassTrack) {
    if (!loaded || loaded.status !== "ok" || busyKey !== null) return;
    setBusyKey(`${track}:${tier}`);
    setError(null);
    const res = await pass.claim(tier, track).catch(() => null);
    setBusyKey(null);
    if (res?.ok) setClaimed({ base: loaded, view: res.value });
    else setError(res && !res.ok ? res.message : "Could not claim that reward.");
  }

  async function onUnlockWithGems() {
    if (!loaded || loaded.status !== "ok" || busyKey !== null || !pass.premium) return;
    setBusyKey("premium");
    setError(null);
    const res = await pass.premium().catch(() => null);
    setBusyKey(null);
    if (res?.ok) {
      setClaimed({ base: loaded, view: res.value });
      // Re-read the wallet so the balance shows the charge.
      setWalletRev((r) => r + 1);
    } else setError(res && !res.ok ? res.message : "Could not unlock premium.");
  }

  const view = state?.status === "ok" ? state.view : null;
  const gemOffer =
    canGems && view && !view.premium && typeof view.premiumGems === "number"
      ? { price: view.premiumGems, gems: gemBalance ?? null, busy: busyKey === "premium" }
      : undefined;

  return (
    <BattlePassBody
      state={state}
      busyKey={busyKey}
      error={error}
      now={now}
      compact={compact}
      onClaim={(tier, track) => void onClaim(tier, track)}
      onBuyPremium={props.onBuyPremium ? () => props.onBuyPremium?.() : undefined}
      gemOffer={gemOffer}
      onUnlockWithGems={() => void onUnlockWithGems()}
      onRetry={() => setRevision((r) => r + 1)}
    />
  );
}
