/**
 * QA scenario: classic-town (docs/design/wave-B.md §11). OWNER: T-classic-presence.
 *
 * A classic hero in the town (manual control, so it stays there) and a Node
 * WebSocket bot as the second player: guest via POST /api/guest, then
 * /ws?token&world=classic-town, sending poses while it walks around the plaza
 * near the town spawn (36,46). The bot records what the server sends it, so it
 * shows whether the page's own hero reaches the town world, and the page's
 * presence state (window.__gamez.presence, when classic wires TownPresence)
 * shows whether the bot is drawn there.
 *
 * window.__gamez.presence (optional, set by the classic client) is read as
 * { connected, othersShown, lastError, avatars?: { id, name, tag, x, y }[] } (TownPresence itself).
 */
import { classArg, startClassic, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

/** Minimal shape of the global WebSocket (Node 22+), so no DOM lib or dependency is needed. */
interface BotSocket {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
type BotSocketCtor = new (url: string) => BotSocket;

interface BotEntity {
  id: string;
  name: string;
  tag?: string;
  pos: { x: number; y: number };
  path: { x: number; y: number }[];
  speed: number;
}

export interface BotReport {
  name: string;
  welcomed: boolean;
  closed: boolean;
  posesSent: number;
  errors: string[];
  /** Largest number of other players the bot saw at once. */
  maxOthers: number;
  /** Tags of the other players the bot saw (e.g. "Lv 3 Warrior" for the page's hero). */
  tagsSeen: string[];
  /** "name|tag" of every other player the bot saw (the page's hero is "<session name>|Lv N <Class>"). */
  seen: string[];
  /** Bot position at the end (tiles). */
  last: { x: number; y: number };
  fatal: string | null;
}

/** Walk loop around the town spawn (36,46): the bot stays on the plaza. */
const WAYPOINTS: readonly { x: number; y: number }[] = [
  { x: 40, y: 46 },
  { x: 40, y: 42 },
  { x: 32, y: 42 },
  { x: 32, y: 46 },
];
const BOT_SPEED = 3; // tiles per second
const POSE_EVERY_MS = 300; // at most 4 pose reports per second
const STEP_MS = 100;
const BOT_TAG = "Lv 5 Bot";

/** Straight-line tile steps from `from` towards `to`, at most 8. */
function straightPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const out: { x: number; y: number }[] = [];
  let x = from.x;
  let y = from.y;
  while (out.length < 8 && (x !== to.x || y !== to.y)) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    out.push({ x, y });
  }
  return out;
}

/**
 * Runs the bot for `durationMs`: joins classic-town as a guest and walks the
 * waypoint loop, reporting its pose at most every POSE_EVERY_MS.
 */
export async function runTownBot(base: string, durationMs: number): Promise<BotReport> {
  const report: BotReport = {
    name: "",
    welcomed: false,
    closed: false,
    posesSent: 0,
    errors: [],
    maxOthers: 0,
    tagsSeen: [],
    seen: [],
    last: { x: 0, y: 0 },
    fatal: null,
  };
  const guestRes = await fetch(`${base}/api/guest`, { method: "POST" });
  if (!guestRes.ok) throw new Error(`POST /api/guest -> ${guestRes.status}`);
  const guest = (await guestRes.json()) as { token: string; name: string };
  report.name = guest.name;

  const WebSocketCtor = (globalThis as unknown as { WebSocket: BotSocketCtor }).WebSocket;
  const wsBase = base.replace(/^http/, "ws");
  const url = `${wsBase}/ws?token=${encodeURIComponent(guest.token)}&world=classic-town`;
  const entities = new Map<string, BotEntity>();
  const tags = new Set<string>();
  const seen = new Set<string>();

  const socket = await new Promise<BotSocket>((resolve, reject) => {
    const ws = new WebSocketCtor(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`websocket error on ${wsBase}/ws`));
  });
  let selfId = "";
  socket.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(e.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.t === "welcome") {
      report.welcomed = true;
      selfId = typeof msg.selfId === "string" ? msg.selfId : "";
      entities.clear();
      for (const en of (msg.entities ?? []) as BotEntity[]) entities.set(en.id, en);
    } else if (msg.t === "delta") {
      for (const en of (msg.upserts ?? []) as BotEntity[]) entities.set(en.id, en);
      for (const id of (msg.removes ?? []) as string[]) entities.delete(id);
    } else if (msg.t === "error") {
      report.errors.push(`${String(msg.code)}: ${String(msg.message)}`);
    }
    let others = 0;
    for (const en of entities.values()) {
      if (en.id === selfId) continue;
      others++;
      if (en.tag) tags.add(en.tag);
      seen.add(`${en.name}|${en.tag ?? ""}`);
    }
    report.maxOthers = Math.max(report.maxOthers, others);
  };
  socket.onclose = () => {
    report.closed = true;
  };

  // Walk the loop: integer tile reports, fractional position advances each step.
  let x = 36;
  let y = 46;
  let target = 0;
  const started = Date.now();
  let lastPose = 0;
  try {
    while (Date.now() - started < durationMs) {
      const goal = WAYPOINTS[target % WAYPOINTS.length];
      if (!goal) break;
      const dx = goal.x - x;
      const dy = goal.y - y;
      const dist = Math.hypot(dx, dy);
      const step = (BOT_SPEED * STEP_MS) / 1000;
      if (dist <= step) {
        x = goal.x;
        y = goal.y;
        target++;
      } else {
        x += (dx / dist) * step;
        y += (dy / dist) * step;
      }
      const now = Date.now();
      if (now - lastPose >= POSE_EVERY_MS) {
        lastPose = now;
        const tile = { x: Math.floor(x), y: Math.floor(y) };
        const nextGoal = WAYPOINTS[target % WAYPOINTS.length] ?? goal;
        const path = straightPath(tile, nextGoal);
        socket.send(
          JSON.stringify({
            t: "pose",
            pos: tile,
            path,
            speed: BOT_SPEED,
            appearance: "unit.hero.rogue",
            tag: BOT_TAG,
          }),
        );
        report.posesSent++;
      }
      await new Promise((r) => setTimeout(r, STEP_MS));
    }
  } catch (err) {
    report.fatal = err instanceof Error ? err.message : String(err);
  } finally {
    report.last = { x: Math.floor(x), y: Math.floor(y) };
    report.tagsSeen = [...tags].sort();
    report.seen = [...seen].sort();
    socket.close();
    // Give the close a moment to reach the onclose handler.
    await new Promise((r) => setTimeout(r, 100));
  }
  return report;
}

interface PresenceHook {
  connected: boolean;
  othersShown: number;
  lastError: string | null;
  avatars?: { id: string; x: number; y: number; name?: string; tag?: string | null }[];
}

const presenceOf = (run: Run): Promise<PresenceHook | null> =>
  run.page.evaluate<PresenceHook | null>(
    `(() => { const p = window.__gamez?.presence; if (!p) return null;
      return { connected: !!p.connected, othersShown: p.othersShown ?? 0,
        lastError: p.lastError ?? null,
        avatars: Array.isArray(p.avatars) ? p.avatars.map((a) => ({ id: a.id, x: a.x, y: a.y, name: a.name, tag: a.tag })) : undefined };
    })()`,
  );

const entitiesOf = (run: Run): Promise<number | null> =>
  run.page.evaluate<number | null>("window.__gamez?.render?.entities ?? null");

export const CLASSIC_TOWN_RUNNERS: Record<string, Runner> = {
  "classic-town": async (run) => {
    const cls = classArg(run);
    await startClassic(run, cls);
    // Manual control keeps the hero in town (auto would walk into the dungeon).
    await run.page.waitFor("!!window.__gamez?.controls", 15_000);
    await run.page.evaluate("window.__gamez.controls.setMode('manual')");
    await run.page.wait(800);
    // The first-run tip covers the plaza; close it so the screenshots show the avatars.
    try {
      await run.page.clickText("Got it", { exact: true, timeoutMs: 3000 });
      await run.page.wait(300);
    } catch {
      // No tip shown (already dismissed in this profile).
    }
    const before = await entitiesOf(run);
    const othersBefore = (await presenceOf(run))?.othersShown ?? 0;
    await run.shot("town-alone");

    const botMs = 20_000;
    const botDone = runTownBot(run.args.url, botMs);

    // Watch the page for the bot's avatar (up to 15 s), shooting when it appears.
    let hook: PresenceHook | null = null;
    let shotTaken = false;
    let maxSeen = 0;
    // Per avatar: first position, furthest move and name. Other live sessions on the
    // dev server may be drawn too, so the walk check only looks at the bot's avatar.
    const firstPos = new Map<string, { x: number; y: number; name?: string; moved: number }>();
    const watchStart = Date.now();
    while (Date.now() - watchStart < 15_000) {
      await run.page.wait(500);
      hook = await presenceOf(run);
      if (hook) {
        maxSeen = Math.max(maxSeen, hook.othersShown);
        for (const a of hook.avatars ?? []) {
          const f = firstPos.get(a.id);
          if (!f) firstPos.set(a.id, { x: a.x, y: a.y, name: a.name, moved: 0 });
          else f.moved = Math.max(f.moved, Math.hypot(a.x - f.x, a.y - f.y));
        }
        if (hook.othersShown >= 1 && !shotTaken) {
          await run.shot("town-with-bot");
          shotTaken = true;
        }
      }
    }
    const during = await entitiesOf(run);
    const othersDuring = (await presenceOf(run))?.othersShown ?? 0;
    if (!shotTaken) await run.shot("town-with-bot");
    const bot = await botDone;
    // After the bot closed its socket the server drops its avatar; the page must remove it.
    let finalHook = await presenceOf(run);
    const leaveStart = Date.now();
    while (
      Date.now() - leaveStart < 6_000 &&
      (finalHook?.avatars ?? []).some((a) => a.name === bot.name)
    ) {
      await run.page.wait(250);
      finalHook = await presenceOf(run);
    }
    const botStillDrawn = (finalHook?.avatars ?? []).some((a) => a.name === bot.name);
    let moved = 0;
    const otherSessions: { name?: string; movedTiles: number }[] = [];
    for (const f of firstPos.values()) {
      if (f.name === bot.name) moved = Math.max(moved, f.moved);
      else otherSessions.push({ name: f.name, movedTiles: Number(f.moved.toFixed(2)) });
    }

    run.report.data.bot = bot;
    run.report.data.presence = {
      hook: finalHook,
      maxOthersShown: maxSeen,
      maxMovedTiles: moved,
      otherSessions,
    };
    run.report.data.renderEntities = { before, during, othersBefore, othersDuring };

    run.check(
      "classic exposes the town presence hook (window.__gamez.presence)",
      finalHook !== null,
      {
        note: "wired by T-classic-sync (TownPresence in the classic client)",
      },
    );
    run.check("bot joined classic-town as a guest", bot.welcomed && bot.fatal === null, bot);
    run.check("server accepted the bot's poses", bot.posesSent > 20 && bot.errors.length === 0, {
      posesSent: bot.posesSent,
      errors: bot.errors.slice(0, 5),
    });
    // The page's avatar carries its guest session name and a "Lv N <Class>" tag.
    const pageName = await run.page.evaluate<string | null>(
      `(() => { try { return JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "null")?.name ?? null; } catch { return null; } })()`,
    );
    const pageSeen = bot.seen.filter((s) => pageName !== null && s.startsWith(`${pageName}|Lv `));
    run.check(
      "page's hero reaches the town world (bot sees its name and Lv tag)",
      pageSeen.length > 0,
      {
        pageName,
        matching: pageSeen,
        seen: bot.seen.slice(0, 10),
      },
    );
    run.check("page draws the bot's avatar (othersShown >= 1)", maxSeen >= 1, {
      maxOthersShown: maxSeen,
      lastError: finalHook?.lastError ?? null,
    });
    run.check("town presence reports no swallowed error", finalHook?.lastError == null, {
      lastError: finalHook?.lastError ?? null,
    });
    run.check(
      "the bot's avatar walks on the page (position changes)",
      moved >= 1,
      { maxMovedTiles: Number(moved.toFixed(2)) },
      true,
    );
    run.check(
      "render entity count follows the drawn avatars",
      before !== null && during !== null && during - before >= othersDuring - othersBefore,
      { before, during, othersBefore, othersDuring },
      true,
    );
    run.check(
      "bot's avatar removed from the page after it left",
      finalHook !== null && !botStillDrawn,
      { bot: bot.name, avatars: finalHook?.avatars ?? null },
    );
  },
};
