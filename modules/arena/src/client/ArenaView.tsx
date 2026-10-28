/**
 * ArenaView (OWNER: T-arena-sim): the presentational arena screen. It takes
 * loaded data and callbacks, so every state (loading, unavailable, error,
 * empty, data, queued) renders from plain props and is testable with
 * renderToStaticMarkup. ArenaScreen owns the fetching and the poll loop.
 */
import type { ArenaLadderResponse, ArenaMatchSummary, ArenaStatus } from "@gamez/protocol";
import { ARENA_CSS } from "./styles.ts";
import { classColour, classLabel, isYou } from "./model.ts";

export type Load<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "unavailable" }
  | { state: "error"; message: string };

export type ArenaTab = "fight" | "ladder";

export interface FightState {
  phase: "idle" | "queueing" | "waiting" | "failed";
  /** Seconds spent waiting for an opponent. */
  seconds: number;
  /** Failure or error text (shown above the fight button). */
  message: string | null;
}

export interface ArenaViewProps {
  status: Load<ArenaStatus>;
  ladder: Load<ArenaLadderResponse>;
  tab: ArenaTab;
  accountId: string;
  fight: FightState;
  /** A replayed match is being fetched. */
  opening: string | null;
  onTab: (tab: ArenaTab) => void;
  onFight: () => void;
  onRetry: () => void;
  onReplay: (id: string) => void;
  onClose: () => void;
  /** The host sheet shows the title and Close (ArenaScreenProps.embedded). */
  embedded?: boolean;
}

const SIGN = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function Header(props: { title: string; onClose: () => void }) {
  return (
    <div className="arena-head">
      <h1 className="arena-title">{props.title}</h1>
      <button type="button" className="arena-btn" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}

function Recent(props: {
  rows: ArenaMatchSummary[];
  opening: string | null;
  onReplay: (id: string) => void;
}) {
  if (props.rows.length === 0) {
    return <p className="arena-empty">No fights yet. Queue your first one above.</p>;
  }
  return (
    <ul className="arena-list" aria-label="Recent matches">
      {props.rows.map((m) => (
        <li key={m.id} className="arena-row">
          <span
            className={`arena-${m.result === "win" ? "win" : m.result === "loss" ? "loss" : "draw"}`}
          >
            {m.result === "win" ? "Win" : m.result === "loss" ? "Loss" : "Draw"}
          </span>
          <span className="arena-grow">
            vs {m.opponent.displayName}
            {m.defended ? " (defended)" : ""}
          </span>
          <span aria-label="rating change">{SIGN(m.ratingDelta)}</span>
          <button
            type="button"
            className="arena-btn"
            onClick={() => props.onReplay(m.id)}
            disabled={props.opening !== null}
          >
            {props.opening === m.id ? "Loading" : "Replay"}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FightTab(
  props: Omit<ArenaViewProps, "tab" | "ladder" | "accountId" | "onTab" | "onClose">,
) {
  const { status, fight } = props;
  if (status.state === "loading") return <p className="arena-loading">Loading the arena...</p>;
  if (status.state === "unavailable")
    return <p className="arena-empty">The arena is not open yet.</p>;
  if (status.state === "error") {
    return (
      <div>
        <p className="arena-msg">{status.message}</p>
        <button type="button" className="arena-btn arena-primary" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    );
  }
  const s = status.value;
  const busy = fight.phase === "queueing" || fight.phase === "waiting";
  const noneLeft = s.fightsLeftToday <= 0;
  const label =
    fight.phase === "queueing"
      ? "Queuing..."
      : fight.phase === "waiting"
        ? `Searching... ${fight.seconds} s`
        : "Fight";
  return (
    <div>
      <div className="arena-stats">
        <div className="arena-stat">
          <b>{s.rating}</b>
          <span>Rating</span>
        </div>
        <div className="arena-stat">
          <b>{s.wins}</b>
          <span>Wins</span>
        </div>
        <div className="arena-stat">
          <b>{s.losses}</b>
          <span>Losses</span>
        </div>
        <div className="arena-stat">
          <b>{s.fightsLeftToday}</b>
          <span>Left today</span>
        </div>
      </div>
      {!s.registered ? (
        <p className="arena-note">Your hero joins the ghost pool with your first fight.</p>
      ) : null}
      <button
        type="button"
        className="arena-btn arena-primary"
        style={{ width: "100%" }}
        onClick={props.onFight}
        disabled={busy || noneLeft}
      >
        {noneLeft && !busy ? "No fights left today" : label}
      </button>
      {fight.message ? (
        <p className="arena-msg" role="alert">
          {fight.message}
        </p>
      ) : null}
      <section className="arena-section" aria-label="Your recent fights">
        <h2>Recent fights</h2>
        <Recent rows={s.recent} opening={props.opening} onReplay={props.onReplay} />
      </section>
    </div>
  );
}

function LadderTab(props: {
  ladder: Load<ArenaLadderResponse>;
  accountId: string;
  onRetry: () => void;
}) {
  const { ladder } = props;
  if (ladder.state === "loading") return <p className="arena-loading">Loading the ladder...</p>;
  if (ladder.state === "unavailable")
    return <p className="arena-empty">The ladder is not open yet.</p>;
  if (ladder.state === "error") {
    return (
      <div>
        <p className="arena-msg">{ladder.message}</p>
        <button type="button" className="arena-btn" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (!ladder.value.available) return <p className="arena-empty">The ladder is not open yet.</p>;
  if (ladder.value.rows.length === 0) return <p className="arena-empty">No ranked heroes yet.</p>;
  return (
    <ol className="arena-list" aria-label={`Ladder, season ${ladder.value.seasonId}`}>
      {ladder.value.rows.map((r) => {
        const you = isYou(props.accountId, r.accountId);
        return (
          <li
            key={`${r.rank}:${r.accountId}`}
            className={`arena-row${you ? " arena-you" : ""}`}
            aria-current={you ? "true" : undefined}
          >
            <span className="arena-rank">{r.rank}</span>
            <span
              className="arena-dot"
              style={{ background: classColour(r.classId) }}
              aria-hidden="true"
            />
            <span className="arena-grow">
              {r.displayName}
              {you ? " (you)" : ""}{" "}
              <small>
                {classLabel(r.classId)} {r.level}
              </small>
            </span>
            <span>{r.rating}</span>
            <span className="arena-note">
              {r.wins}W {r.losses}L
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ArenaView(props: ArenaViewProps) {
  const { tab } = props;
  return (
    <section className="arena-root" aria-label="Arena">
      <style>{ARENA_CSS}</style>
      {props.embedded ? null : <Header title="Arena" onClose={props.onClose} />}
      <div className="arena-tabs" role="group" aria-label="Arena sections">
        <button
          type="button"
          className="arena-btn"
          aria-pressed={tab === "fight"}
          onClick={() => props.onTab("fight")}
        >
          Fight
        </button>
        <button
          type="button"
          className="arena-btn"
          aria-pressed={tab === "ladder"}
          onClick={() => props.onTab("ladder")}
        >
          Ladder
        </button>
      </div>
      {tab === "fight" ? (
        <FightTab
          status={props.status}
          fight={props.fight}
          opening={props.opening}
          onFight={props.onFight}
          onRetry={props.onRetry}
          onReplay={props.onReplay}
        />
      ) : (
        <LadderTab ladder={props.ladder} accountId={props.accountId} onRetry={props.onRetry} />
      )}
    </section>
  );
}
