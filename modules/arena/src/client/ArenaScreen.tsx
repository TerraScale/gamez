/**
 * ArenaScreen (OWNER: T-arena-sim): the arena for the "arena" platform screen.
 * It fetches status and ladder through platform.arena, queues a fight (one
 * opId per logical call, reused for retries), polls the ticket every second
 * and then replays the match. Every state is rendered by ArenaView.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaLadderResponse, ArenaMatch, ArenaStatus } from "@gamez/protocol";
import { ArenaReplay } from "./ArenaReplay.tsx";
import { ArenaView, type ArenaTab, type FightState, type Load } from "./ArenaView.tsx";
import { ARENA_CSS } from "./styles.ts";
import { failureText, MAX_POLLS, newArenaOpId, POLL_MS, ticketStep } from "./model.ts";
import type { ArenaScreenProps } from "./index.ts";

type Failure = { ok: false; code: string; message: string };

function toLoad<T>(r: { ok: true; value: T } | Failure): Load<T> {
  if (r.ok) return { state: "ready", value: r.value };
  if (r.code === "unavailable") return { state: "unavailable" };
  return { state: "error", message: r.message || "Something went wrong." };
}

export function ArenaScreen(props: ArenaScreenProps) {
  const { platform, accountId, onClose } = props;
  const mode = props.mode ?? "classic";
  const api = platform.arena;
  const [status, setStatus] = useState<Load<ArenaStatus>>({ state: "loading" });
  const [ladder, setLadder] = useState<Load<ArenaLadderResponse>>({ state: "loading" });
  const [tab, setTab] = useState<ArenaTab>("fight");
  const [fight, setFight] = useState<FightState>({ phase: "idle", seconds: 0, message: null });
  const [ticket, setTicket] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [replay, setReplay] = useState<ArenaMatch | null>(null);
  const opRef = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    if (!api) {
      setStatus({ state: "unavailable" });
      return;
    }
    const r = await api.status(mode);
    if (!alive.current) return;
    setStatus(toLoad(r));
    if (r.ok && r.value.ticket) {
      setTicket(r.value.ticket);
      setFight({ phase: "waiting", seconds: 0, message: null });
    }
  }, [api, mode]);

  const loadLadder = useCallback(async () => {
    if (!api) {
      setLadder({ state: "unavailable" });
      return;
    }
    setLadder({ state: "loading" });
    const r = await api.ladder({ mode, limit: 50 });
    if (alive.current) setLadder(toLoad(r));
  }, [api, mode]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (tab === "ladder") void loadLadder();
  }, [tab, loadLadder]);

  // Queue poll: one ticket request per second until matched, failed or MAX_POLLS.
  useEffect(() => {
    if (!ticket || !api) return;
    let polls = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = async (): Promise<void> => {
      if (cancelled) return;
      polls++;
      const r = await api.poll(ticket, mode);
      if (cancelled) return;
      if (!r.ok) {
        if (polls >= MAX_POLLS) {
          setTicket(null);
          setFight({ phase: "idle", seconds: 0, message: failureText(r.code) });
          return;
        }
        timer = setTimeout(() => void step(), POLL_MS);
        return;
      }
      const s = ticketStep(r.value);
      if (s.kind === "matched") {
        setTicket(null);
        setFight({ phase: "idle", seconds: 0, message: null });
        setReplay(s.match);
        void loadStatus();
        return;
      }
      if (s.kind === "failed") {
        setTicket(null);
        setFight({ phase: "idle", seconds: 0, message: failureText(s.reason) });
        return;
      }
      if (polls >= MAX_POLLS) {
        setTicket(null);
        setFight({ phase: "idle", seconds: 0, message: "Still searching. Try again in a moment." });
        return;
      }
      setFight((f) => ({ ...f, seconds: polls }));
      timer = setTimeout(() => void step(), POLL_MS);
    };
    timer = setTimeout(() => void step(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ticket, api, mode, loadStatus]);

  const onFight = async () => {
    if (!api) return;
    const opId = (opRef.current ??= newArenaOpId());
    setFight({ phase: "queueing", seconds: 0, message: null });
    const r = await api.queue(mode, opId);
    if (!alive.current) return;
    if (!r.ok) {
      setFight({
        phase: "failed",
        seconds: 0,
        message: r.code === "unavailable" ? "The arena is not open yet." : failureText(r.code),
      });
      return;
    }
    opRef.current = null;
    const s = ticketStep(r.value);
    if (s.kind === "matched") {
      setFight({ phase: "idle", seconds: 0, message: null });
      setReplay(s.match);
      void loadStatus();
    } else if (s.kind === "failed") {
      setFight({ phase: "idle", seconds: 0, message: failureText(s.reason) });
      void loadStatus();
    } else {
      setTicket(r.value.ticket);
      setFight({ phase: "waiting", seconds: 0, message: null });
    }
  };

  const openReplay = async (id: string) => {
    if (!api) return;
    setOpening(id);
    const r = await api.match(id, mode);
    if (!alive.current) return;
    setOpening(null);
    if (r.ok) setReplay(r.value);
    else setFight((f) => ({ ...f, message: r.message || "That fight could not be loaded." }));
  };

  if (replay) {
    return (
      <div>
        <div className="arena-root" style={{ paddingBottom: 0 }}>
          <style>{ARENA_CSS}</style>
          <div className="arena-head">
            <h1 className="arena-title">Replay</h1>
            <button type="button" className="arena-btn" onClick={() => setReplay(null)}>
              Back
            </button>
          </div>
        </div>
        <ArenaReplay key={replay.id} match={replay} viewerId={accountId} />
      </div>
    );
  }

  return (
    <ArenaView
      status={status}
      ladder={ladder}
      tab={tab}
      accountId={accountId}
      fight={fight}
      opening={opening}
      onTab={setTab}
      onFight={() => void onFight()}
      onRetry={() => void (tab === "ladder" ? loadLadder() : loadStatus())}
      onReplay={(id) => void openReplay(id)}
      onClose={onClose}
      embedded={props.embedded}
    />
  );
}
