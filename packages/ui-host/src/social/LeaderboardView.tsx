/**
 * Leaderboard tables with board tabs and a class filter (wave-B.md §4, §8.3).
 * Rows are a list, not a table, so they fit 375 px. Presentational parts are
 * exported for tests.
 */
import { useState, type CSSProperties } from "react";
import type { LeaderboardBoard, LeaderboardResponse, LeaderboardRow } from "@gamez/protocol";
import type { LeaderboardApi } from "../platform.ts";
import { useLoad } from "./hooks.ts";
import { leaderboardQuery, loadLeaderboard, type BoardState } from "./flows.ts";
import { BOARD_TABS, formatInt } from "./text.ts";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  badgeStyle,
  errorTextStyle,
  headingStyle,
  listStyle,
  mutedStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
  socialTabStyle,
  inputStyle,
  fieldLabelStyle,
} from "./styles.ts";

export interface LeaderboardViewProps {
  api: LeaderboardApi;
  /** Mode whose boards to show ("classic"). */
  mode: string;
  /** Class filter options; empty = no filter. */
  classes: readonly { id: string; name: string }[];
  /** Highlights own rows. */
  selfId: string | null;
  compact?: boolean;
}

export function LeaderboardView({
  api,
  mode,
  classes,
  selfId,
  compact = false,
}: LeaderboardViewProps) {
  const [board, setBoard] = useState<LeaderboardBoard>("level");
  const [classId, setClassId] = useState("");
  const [revision, setRevision] = useState(0);
  const state = useLoad<BoardState>(
    () =>
      loadLeaderboard(api, leaderboardQuery(board, mode, classId)).catch((): BoardState => ({
        status: "error",
        message: "Could not reach the leaderboards.",
      })),
    [api, board, mode, classId, revision],
  );
  const classNames = Object.fromEntries(classes.map((c) => [c.id, c.name]));
  const boardLabel = BOARD_TABS.find((t) => t.id === board)?.value ?? "Value";

  return (
    <section aria-label="Leaderboards" style={{ ...sheetStyle, padding: compact ? 8 : 12 }}>
      <header style={{ ...rowStyle, justifyContent: "space-between" }}>
        <h2 style={headingStyle}>Leaderboards</h2>
        <button
          type="button"
          aria-label="Refresh leaderboard"
          onClick={() => setRevision((r) => r + 1)}
          style={socialButtonStyle()}
        >
          Refresh
        </button>
      </header>
      <div role="tablist" aria-label="Boards" style={rowStyle}>
        {BOARD_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === board}
            onClick={() => setBoard(t.id)}
            style={socialTabStyle(t.id === board)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {classes.length > 0 ? (
        <label style={{ ...fieldLabelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
          Class
          <select
            aria-label="Class filter"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            style={{ ...inputStyle, color: SOCIAL_C.text }}
          >
            <option value="">All</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <LeaderboardBody
        state={state}
        valueLabel={boardLabel}
        board={board}
        selfId={selfId}
        classNames={classNames}
        compact={compact}
      />
    </section>
  );
}

export function LeaderboardBody({
  state,
  board,
  valueLabel,
  selfId,
  classNames,
  compact = false,
}: {
  state: BoardState | undefined;
  board: LeaderboardBoard;
  valueLabel: string;
  selfId: string | null;
  classNames: Readonly<Record<string, string>>;
  compact?: boolean;
}) {
  if (!state || state.status === "loading") {
    return (
      <p role="status" style={mutedStyle}>
        Loading rankings…
      </p>
    );
  }
  if (state.status === "warming") {
    return (
      <p role="status" style={mutedStyle}>
        Leaderboards are warming up. Rankings appear once the first runs are verified.
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" style={errorTextStyle}>
        {`Rankings could not load. ${state.message}`}
      </p>
    );
  }
  return (
    <LeaderboardList
      response={state.response}
      board={board}
      valueLabel={valueLabel}
      selfId={selfId}
      classNames={classNames}
      compact={compact}
    />
  );
}

export function LeaderboardList({
  response,
  board,
  valueLabel,
  selfId,
  classNames,
  compact = false,
}: {
  response: LeaderboardResponse;
  board: LeaderboardBoard;
  valueLabel: string;
  selfId: string | null;
  classNames: Readonly<Record<string, string>>;
  compact?: boolean;
}) {
  if (response.rows.length === 0) {
    return (
      <p role="status" style={mutedStyle}>
        No one has ranked here yet. Be the first.
      </p>
    );
  }
  return (
    <ol
      aria-label={`${valueLabel} rankings`}
      style={{ ...listStyle, maxHeight: compact ? 240 : 420, overflowY: "auto" }}
    >
      {response.rows.map((row) => (
        <LeaderboardRowItem
          key={row.accountId + ":" + row.rank}
          row={row}
          board={board}
          own={selfId !== null && row.accountId === selfId}
          className={classNames[row.classId] ?? row.classId}
          compact={compact}
        />
      ))}
    </ol>
  );
}

export function valueText(board: LeaderboardBoard, value: number): string {
  switch (board) {
    case "level":
      return `Lv ${formatInt(value)}`;
    case "depth":
      return `Depth ${formatInt(value)}`;
    case "rift":
      return formatInt(value);
  }
}

function LeaderboardRowItem({
  row,
  board,
  own,
  className,
  compact,
}: {
  row: LeaderboardRow;
  board: LeaderboardBoard;
  own: boolean;
  className: string;
  compact: boolean;
}) {
  const look: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: SOCIAL_TOUCH,
    padding: compact ? "4px 8px" : "6px 10px",
    borderRadius: 8,
    border: `1px solid ${own ? SOCIAL_C.borderStrong : SOCIAL_C.border}`,
    background: own ? SOCIAL_C.own : SOCIAL_C.field,
    minWidth: 0,
    boxSizing: "border-box",
  };
  return (
    <li data-own={own ? "true" : undefined} style={look}>
      <span
        aria-label={`Rank ${row.rank}`}
        style={{ color: SOCIAL_C.gold, fontWeight: 700, minWidth: 36, textAlign: "right" }}
      >
        {`#${row.rank}`}
      </span>
      <div
        style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}
      >
        <div style={{ ...rowStyle, gap: 6 }}>
          <span
            style={{
              fontWeight: 700,
              color: own ? SOCIAL_C.goldBright : SOCIAL_C.text,
              overflowWrap: "anywhere",
            }}
          >
            {row.displayName}
          </span>
          {own ? <span style={{ ...mutedStyle, fontSize: 11 }}>(you)</span> : null}
          {row.imported ? <span style={badgeStyle}>Imported</span> : null}
        </div>
        <span style={{ ...mutedStyle, overflowWrap: "anywhere" }}>
          {`${row.heroName} · Lv ${formatInt(row.heroLevel)} · ${className}`}
        </span>
      </div>
      <span style={{ fontWeight: 700, whiteSpace: "nowrap", color: SOCIAL_C.goldBright }}>
        {valueText(board, row.value)}
      </span>
    </li>
  );
}
