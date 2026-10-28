/**
 * Presentational duel screen: arena, move menu, commands, team panel and the
 * battle log. Pure props in, callbacks out; the connection lives in mode.tsx.
 */
import { useEffect, useRef } from "react";
import type { BattleView, MonView } from "./model.ts";
import "./duel.css";

export interface LogLine {
  id: number;
  text: string;
}

export interface DuelScreenProps {
  view: BattleView | null;
  status: "connecting" | "online" | "offline";
  error: { code: string; message: string } | null;
  log: LogLine[];
  busy: boolean;
  /** Team panel open for choosing a creature to send out. */
  switchOpen: boolean;
  onMove: (moveId: string) => void;
  onSwitch: (slot: number) => void;
  onCapture: () => void;
  onFlee: () => void;
  onNext: () => void;
  onHeal: () => void;
  onToggleSwitch: () => void;
}

/** Simple inline art: one body shape per element, same face for everyone. */
const ART_PATHS: Record<string, string> = {
  ember: "M32 6 C40 18 48 24 46 38 C44 50 20 50 18 38 C16 26 26 22 28 14 C30 20 32 18 32 6 Z",
  sprout: "M32 8 C54 20 54 46 32 56 C10 46 10 20 32 8 Z",
  tide: "M10 36 C10 18 54 18 54 36 C54 52 44 56 32 56 C20 56 10 52 10 36 Z",
  volt: "M32 4 L40 24 L58 26 L44 38 L50 58 L32 46 L14 58 L20 38 L6 26 L24 24 Z",
};

function CreatureArt({ element, side }: { element: string; side: "player" | "wild" }) {
  return (
    <svg
      className={`duel-art duel-art-${side}`}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="32" cy="58" rx="20" ry="4" className="duel-art-shadow" />
      <path d={ART_PATHS[element] ?? ART_PATHS.tide} className={`duel-art-body el-${element}`} />
      <circle cx="25" cy="32" r="3" className="duel-art-eye" />
      <circle cx="39" cy="32" r="3" className="duel-art-eye" />
    </svg>
  );
}

function HpBar({ hp, maxHp, label }: { hp: number; maxHp: number; label: string }) {
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, Math.round((hp * 100) / maxHp))) : 0;
  const tone = pct > 50 ? "good" : pct > 20 ? "warn" : "bad";
  return (
    <div
      className="duel-hp"
      role="progressbar"
      aria-label={`${label} HP`}
      aria-valuemin={0}
      aria-valuemax={maxHp}
      aria-valuenow={hp}
      aria-valuetext={`${hp} of ${maxHp}`}
    >
      <div className={`duel-hp-fill duel-hp-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ElementBadge({ element, name }: { element: string; name: string }) {
  return <span className={`duel-badge el-${element}`}>{name}</span>;
}

function CreatureCard({ mon, role }: { mon: MonView; role: string }) {
  return (
    <article className={`duel-card duel-card-${mon.side} ${mon.fainted ? "is-fainted" : ""}`}>
      <div className="duel-card-head">
        <h2 className="duel-card-name">{mon.name}</h2>
        <span className="duel-card-level">Lv {mon.level}</span>
      </div>
      <div className="duel-card-meta">
        <span className="duel-role">{role}</span>
        <ElementBadge element={mon.element} name={mon.elementName} />
      </div>
      <CreatureArt element={mon.element} side={mon.side} />
      <HpBar hp={mon.hp} maxHp={mon.maxHp} label={mon.name} />
      <p className="duel-card-hp">
        {mon.hp} / {mon.maxHp} HP
      </p>
    </article>
  );
}

function BattleLog({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <ol ref={ref} className="duel-log" role="log" aria-live="polite">
      {lines.length === 0 ? (
        <li className="duel-log-empty">The battle has not started yet.</li>
      ) : null}
      {lines.map((line) => (
        <li key={line.id}>{line.text}</li>
      ))}
    </ol>
  );
}

export function DuelScreen(props: DuelScreenProps) {
  const {
    view,
    status,
    error,
    log,
    busy,
    switchOpen,
    onMove,
    onSwitch,
    onCapture,
    onFlee,
    onNext,
    onHeal,
    onToggleSwitch,
  } = props;

  if (view === null) {
    return (
      <main className="duel">
        <h1 className="duel-title">Duel</h1>
        {error ? (
          <p className="duel-error" role="alert">
            {error.message}
          </p>
        ) : null}
        <p className="duel-status" role="status">
          {status === "offline"
            ? "Connection lost. Leave and come back to reconnect."
            : "Connecting to your battle…"}
        </p>
      </main>
    );
  }

  const sendingOut = switchOpen || view.phase === "switch";
  const lead = view.lead;

  return (
    <main className="duel" data-phase={view.phase}>
      <header className="duel-head">
        <h1 className="duel-title">Duel</h1>
        <span className="duel-meta">
          {/* view.turn counts finished turns; while a battle runs, show the one being chosen. */}
          Battle {view.battles} · Turn {view.phase === "ended" ? view.turn : view.turn + 1}
          {status === "connecting" ? " · reconnecting" : ""}
        </span>
      </header>

      {error ? (
        <p className="duel-error" role="alert">
          {error.message}
        </p>
      ) : null}

      <section className="duel-arena" aria-label="Battlefield">
        {view.wild ? <CreatureCard mon={view.wild} role="Wild" /> : null}
        {lead ? <CreatureCard mon={lead} role="Yours" /> : null}
      </section>

      <p className="duel-status" role="status">
        {view.status}
      </p>

      <section className="duel-moves" aria-label="Moves">
        {lead?.moves.map((move) => {
          const usable = view.canMove && move.pp > 0 && !busy;
          return (
            <button
              key={move.id}
              type="button"
              className={`duel-move el-${move.element}`}
              disabled={!usable}
              onClick={() => onMove(move.id)}
              aria-label={`${move.name}, ${move.elementName}, power ${move.power}, ${move.pp} of ${move.maxPp} PP left`}
            >
              <span className="duel-move-name">{move.name}</span>
              <span className="duel-move-info">
                {move.elementName} · Pow {move.power} · {move.pp}/{move.maxPp} PP
              </span>
            </button>
          );
        })}
      </section>

      <section className="duel-commands" aria-label="Commands">
        <button type="button" disabled={!view.canCapture || busy} onClick={onCapture}>
          Capture
        </button>
        <button
          type="button"
          disabled={!view.canSwitch || busy || view.phase === "switch"}
          aria-expanded={switchOpen}
          onClick={onToggleSwitch}
        >
          {switchOpen ? "Close team" : "Switch"}
        </button>
        <button type="button" disabled={!view.canFlee || busy} onClick={onFlee}>
          Flee
        </button>
      </section>

      {view.phase === "ended" ? (
        <section className="duel-between" aria-label="Between battles">
          <button
            type="button"
            className="primary"
            disabled={!view.canNext || busy}
            onClick={onNext}
          >
            Next battle
          </button>
          <button type="button" disabled={!view.canHeal || busy} onClick={onHeal}>
            Heal team
          </button>
        </section>
      ) : null}

      <section className="duel-team" aria-label="Team">
        <h2 className="duel-section-title">
          Team <span className="duel-count">{view.team.length} / 6</span>
          {view.box.length > 0 ? (
            <span className="duel-count"> · Box {view.box.length}</span>
          ) : null}
        </h2>
        <ul className="duel-team-list">
          {view.team.map((mon) => {
            const active = lead !== null && mon.entity === lead.entity;
            const canSend = sendingOut && !active && !mon.fainted && view.canSwitch && !busy;
            return (
              <li
                key={mon.entity}
                className={`duel-team-row ${active ? "is-active" : ""} ${mon.fainted ? "is-fainted" : ""}`}
              >
                <div className="duel-team-info">
                  <span className="duel-team-name">
                    {mon.name} <span className="duel-card-level">Lv {mon.level}</span>
                  </span>
                  <HpBar hp={mon.hp} maxHp={mon.maxHp} label={mon.name} />
                  <span className="duel-team-hp">
                    {mon.fainted ? "Fainted" : active ? "In battle" : `${mon.hp} / ${mon.maxHp} HP`}
                  </span>
                </div>
                {sendingOut && !active ? (
                  <button type="button" disabled={!canSend} onClick={() => onSwitch(mon.slot)}>
                    Send out
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="duel-logwrap" aria-label="Battle log">
        <h2 className="duel-section-title">Battle log</h2>
        <BattleLog lines={log} />
      </section>
    </main>
  );
}
