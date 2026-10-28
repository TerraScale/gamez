/**
 * ArenaReplay (OWNER: T-arena-sim): plays a match back from its frames.
 * The frames come from fight(builds, seed, {frames:true}), so the replay
 * shows what the server resolved. Two fighter cards (hp, shield), a lane with
 * a camera that frames both fighters, floating numbers (damage, crit, heal),
 * the last skill cast as a caption, play/pause, skip and a scrubber, and a
 * result banner at the end.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArenaFrame } from "../fight.ts";
import { ARENA_CSS } from "./styles.ts";
import {
  classColour,
  classLabel,
  planReplay,
  REPLAY_FPS,
  resultLine,
  viewerSide,
} from "./model.ts";
import type { ArenaReplayProps } from "./index.ts";

/** Frames a floating number stays on screen (it fades out in 900 ms). */
const TEXT_FRAMES = 6;

/**
 * Camera over the lane: centred between the fighters, at least 80 tenths wide,
 * so two fighters one tile apart still have room for their avatars.
 */
export function cameraOf(ax: number, dx: number): { left: number; span: number } {
  const center = (ax + dx) / 2;
  const span = Math.max(80, Math.abs(dx - ax) + 60);
  return { left: center - span / 2, span };
}

/** Vertical step between stacked floating numbers on one side (px), and how many rows cycle. */
export const FLOAT_STEP_PX = 18;
export const FLOAT_ROWS = 4;
const FLOAT_BOTTOM_PX = 72;

/**
 * Where the n-th visible floating number of one fighter sits (presentational
 * only): rows stack upwards and alternate a little left and right, so numbers
 * from consecutive frames never print on top of each other.
 */
export function floatOffset(n: number): { bottom: number; marginLeft: number } {
  const row = n % FLOAT_ROWS;
  return { bottom: FLOAT_BOTTOM_PX + row * FLOAT_STEP_PX, marginLeft: -40 + (n % 2 ? 12 : -12) };
}

/** CSS left (percent of the lane) for a lane position in tenths of a tile. */
export function laneLeft(x: number, cam: { left: number; span: number }): string {
  return `${(((x - cam.left) / cam.span) * 100).toFixed(2)}%`;
}

function Card(props: {
  name: string;
  classId: string;
  maxHp: number;
  frame: ArenaFrame["attacker"];
  mine: boolean;
  align: "left" | "right";
}) {
  const { frame, maxHp } = props;
  const hp = Math.max(0, frame.hp);
  const hpPct = Math.max(0, Math.min(100, (hp * 100) / Math.max(1, maxHp)));
  const shieldPct = Math.max(0, Math.min(100, (frame.shield * 100) / Math.max(1, maxHp)));
  return (
    <div
      className={`arena-card${frame.hp <= 0 ? " arena-dead" : ""}`}
      style={{ textAlign: props.align }}
    >
      <span className="arena-cardname" style={{ color: classColour(props.classId) }}>
        {props.name}
        {props.mine ? " (you)" : ""}
      </span>
      <span className="arena-cardclass">{classLabel(props.classId)}</span>
      <div
        className="arena-bar"
        role="meter"
        aria-label={`${props.name} hp`}
        aria-valuemin={0}
        aria-valuemax={maxHp}
        aria-valuenow={hp}
      >
        <i style={{ width: `${hpPct}%` }} />
        {frame.shield > 0 ? (
          <i className="arena-shield" style={{ width: `${shieldPct}%` }} />
        ) : null}
      </div>
      <span className="arena-hpnum">
        {hp} / {maxHp}
        {frame.shield > 0 ? ` +${frame.shield} shield` : ""}
      </span>
    </div>
  );
}

export function ArenaReplay(props: ArenaReplayProps) {
  const { match, viewerId } = props;
  const plan = useMemo(() => planReplay(match), [match]);
  const frames = plan.frames;
  const last = Math.max(0, frames.length - 1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(frames.length > 0);
  const doneSent = useRef(false);
  const side = viewerSide(match, viewerId);
  const onDone = props.onDone;

  useEffect(() => {
    setIndex(0);
    setPlaying(frames.length > 0);
    doneSent.current = false;
  }, [frames]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setIndex((i) => Math.min(last, i + 1));
    }, 1000 / REPLAY_FPS);
    return () => clearInterval(id);
  }, [playing, last]);

  const finished = frames.length === 0 || index >= last;
  useEffect(() => {
    if (finished && playing) setPlaying(false);
    if (finished && !doneSent.current) {
      doneSent.current = true;
      onDone?.();
    }
  }, [finished, playing, onDone]);

  const frame = frames[index] ?? null;
  const shown =
    frames.length === 0 ? [] : frames.slice(Math.max(0, index - TEXT_FRAMES), index + 1);
  const attackerName = match.builds.attacker.name;
  const defenderName = match.builds.defender.name;
  const cam = frame ? cameraOf(frame.attacker.x, frame.defender.x) : { left: 0, span: 200 };
  const banner = finished ? resultLine(plan.winner, side) : null;
  const lastCast = [...shown]
    .reverse()
    .flatMap((f) => f.texts.filter((t) => t.kind === "skill"))[0];

  return (
    <section className="arena-root" aria-label="Arena replay">
      <style>{ARENA_CSS}</style>
      <div className="arena-cards">
        <Card
          name={attackerName}
          classId={match.builds.attacker.classId}
          maxHp={match.builds.attacker.maxHp}
          frame={
            frame
              ? frame.attacker
              : { x: 0, hp: match.builds.attacker.maxHp, shield: 0, action: null }
          }
          mine={side === "attacker"}
          align="left"
        />
        <Card
          name={defenderName}
          classId={match.builds.defender.classId}
          maxHp={match.builds.defender.maxHp}
          frame={
            frame
              ? frame.defender
              : { x: 200, hp: match.builds.defender.maxHp, shield: 0, action: null }
          }
          mine={side === "defender"}
          align="right"
        />
      </div>
      <div className="arena-lane" role="img" aria-label={`${attackerName} against ${defenderName}`}>
        {frame ? (
          <>
            <span
              className="arena-avatar"
              data-side="attacker"
              style={{
                left: laneLeft(frame.attacker.x, cam),
                background: classColour(match.builds.attacker.classId),
                outline: side === "attacker" ? "2px solid #fff8e6" : undefined,
              }}
              aria-hidden="true"
            >
              {classLabel(match.builds.attacker.classId).slice(0, 1)}
            </span>
            <span
              className="arena-avatar"
              data-side="defender"
              style={{
                left: laneLeft(frame.defender.x, cam),
                background: classColour(match.builds.defender.classId),
                outline: side === "defender" ? "2px solid #fff8e6" : undefined,
              }}
              aria-hidden="true"
            >
              {classLabel(match.builds.defender.classId).slice(0, 1)}
            </span>
          </>
        ) : null}
        {(() => {
          // Oldest first: each side's numbers take the next row up.
          const perSide = { attacker: 0, defender: 0 };
          return shown.flatMap((f, fi) => {
            const frameIdx = Math.max(0, index - TEXT_FRAMES) + fi;
            return f.texts
              .filter((t) => t.kind !== "skill")
              .map((t, ti) => {
                const at = floatOffset(perSide[t.side]++);
                return (
                  <span
                    key={`${frameIdx}:${ti}`}
                    className={`arena-float ${t.kind}`}
                    style={{
                      left: laneLeft(f[t.side].x, cam),
                      bottom: at.bottom,
                      marginLeft: at.marginLeft,
                    }}
                  >
                    {t.text}
                  </span>
                );
              });
          });
        })()}
      </div>
      <div className="arena-caption" aria-live="polite">
        {frames.length === 0
          ? "Result only."
          : lastCast
            ? `${lastCast.side === "attacker" ? attackerName : defenderName} casts ${lastCast.text}`
            : " "}
      </div>

      {frames.length > 0 ? (
        <div className="arena-controls">
          <button
            type="button"
            className="arena-btn arena-primary"
            onClick={() => {
              if (finished) setIndex(0);
              setPlaying((p) => (finished ? true : !p));
            }}
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing ? "Pause" : finished ? "Replay again" : "Play"}
          </button>
          <button
            type="button"
            className="arena-btn"
            onClick={() => {
              setPlaying(false);
              setIndex(last);
            }}
            disabled={finished}
          >
            Skip to result
          </button>
          <input
            type="range"
            min={0}
            max={last}
            value={index}
            aria-label="Replay position"
            onChange={(e) => {
              setPlaying(false);
              setIndex(Number(e.target.value));
            }}
          />
        </div>
      ) : null}

      {frames.length === 0 ? (
        <div className="arena-note" aria-live="polite">
          Result only.
        </div>
      ) : (
        <div className="arena-note" aria-live="polite">
          Tick {(frame?.tick ?? 0) + 1} of {plan.ticks}
        </div>
      )}
      {banner ? (
        <div className="arena-banner" role="status" aria-live="polite">
          {banner}
          <small>
            {plan.ticks} ticks ({(plan.ticks / REPLAY_FPS).toFixed(1)} s)
            {plan.winner === "draw"
              ? ""
              : ` · ${plan.winner === "attacker" ? attackerName : defenderName} took the fight`}
          </small>
        </div>
      ) : null}
      {plan.note ? <p className="arena-msg">{plan.note}</p> : null}
    </section>
  );
}
