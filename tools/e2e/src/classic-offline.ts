/**
 * Wave e2e: classic offline/idle progress across a server restart
 * (docs/design/offline-idle.md §5, §10). OWNER: T-tests.
 *
 * run(): a guest joins a fresh classic instance, plays Auto then Idle with
 * every segment verified, and closes the socket (the absence starts there).
 * afterRestart(): a dev admin sets the admin tunable classic.offlineXpPct to
 * 50 (admin-dashboard.md §8) before the absence ends. Once the absence is at
 * least 61 s (the dev server restart is part of it), a rejoin that says
 * "pending, already verified up to the server's tick" must grant the absence
 * now (the old rule blocked it). The grant must use the admin's 50 %: the
 * summary says so, and the server's granted state equals the bot's own
 * dispatch of { elapsedMs, xpPct: 50 } on its verified state (same hash, same
 * XP), whose XP is 2.5x the 20 % grant. The tunable is restored in a finally.
 * An immediate second rejoin gets no second grant. A switch-device join (no
 * resume at all) right after the grant adopts the granted state and gets no
 * second summary either.
 */
import { createSim, type GameEvent, type SimSnapshot } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import type { ClassicEvent } from "@gamez/mode-classic";
import type { VerifiedServerMessage } from "@gamez/protocol";
import { api, registerGuest } from "./accounts.ts";
import { ClassicBot, classicLoaded, type VState } from "./classic-bot.ts";
import { loginGuest, type Guest } from "./client.ts";
import type { E2eFeature } from "./features.ts";
import { check, fail } from "./report.ts";

const NAME = "classic-offline";
/** The server only grants after this much absence (offline-idle.md §5.2). */
const MIN_ABSENCE_MS = 61_000;
const DEFAULT_XP_PCT = 20;
/** The admin's value for this run (docs/design/admin-dashboard.md §8). */
const ADMIN_XP_PCT = 50;
const OFFLINE_XP = "classic.offlineXpPct";
/** The Worker's config cache (config/flags.ts FLAGS_TTL_MS) plus a margin. */
const CONFIG_TTL_MS = 11_000;

export interface ClassicOfflineState {
  guest: Guest;
  tick: number;
  hash: string;
  closedAt: number;
  /** The bot's sim at the verified tick (null when it was not at it). */
  snapshot: SimSnapshot | null;
}

type TunablesBody = { values?: Record<string, number> };

/** A registered dev admin (the local dev host grants POST /api/dev/admin/self). */
async function devAdmin(url: string): Promise<string> {
  const admin = await registerGuest(url, await loginGuest(url), "Offline Admin");
  const self = await api<{ admin?: string }>(url, "/api/dev/admin/self", {
    token: admin.token,
    method: "POST",
  });
  if (self.status !== 200) throw new Error(`classic-offline: dev admin grant ${self.status}`);
  return admin.token;
}

async function setOfflineXp(url: string, token: string, value: number): Promise<boolean> {
  const res = await api<TunablesBody>(url, "/api/admin/tunables", {
    token,
    body: { values: { [OFFLINE_XP]: value } },
  });
  return res.status === 200 && res.body.values?.[OFFLINE_XP] === value;
}

/** The bot's own offline dispatch on its verified state: XP and resulting hash. */
function localGrant(
  snapshot: SimSnapshot,
  elapsedMs: number,
  xpPct: number,
): { xp: number; hash: string } | null {
  const sim = createSim(classicLoaded(), { seed: 0, from: snapshot });
  const res = sim.dispatch(classic.ACTION.offlineProgress, { elapsedMs, xpPct }, "server");
  if (!res.ok) return null;
  const s = (res.events as GameEvent[] as ClassicEvent[]).find(
    (e) => e.type === "classic.offline.summary",
  );
  return s && s.type === "classic.offline.summary" ? { xp: s.xp, hash: sim.hash() } : null;
}

/**
 * One join on its own socket, with the resume fields the bot cannot send
 * (pendingToTick). Resolves with the vstate, or rejects on an error frame.
 */
async function rawJoin(
  url: string,
  guest: Guest,
  resume?: { tick: number; hash: string; pending: boolean; pendingToTick: number },
): Promise<VState> {
  const q = `token=${encodeURIComponent(guest.token)}&mode=classic`;
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws/instance?${q}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("classic-offline: socket error")), {
        once: true,
      });
    });
    const answer = new Promise<VState>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("classic-offline: timed out waiting for vstate")),
        15_000,
      );
      ws.addEventListener("message", (ev: MessageEvent<string>) => {
        const m = JSON.parse(ev.data) as VerifiedServerMessage;
        if (m.t === "vstate") {
          clearTimeout(timer);
          resolve(m);
        } else if (m.t === "error") {
          clearTimeout(timer);
          reject(new Error(`classic-offline: ${m.code}: ${m.message}`));
        }
      });
    });
    ws.send(
      JSON.stringify(
        resume
          ? { t: "join", token: guest.token, mode: "classic", resume }
          : { t: "join", token: guest.token, mode: "classic" },
      ),
    );
    return await answer;
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "bye");
  }
}

/** The classic.offline.summary of a grant, if the grant carries one. */
function summaryOf(v: VState) {
  const events = (v.offline?.events ?? []) as ClassicEvent[];
  return events.find((e) => e.type === "classic.offline.summary");
}

export const classicOfflineFeature: E2eFeature = {
  name: NAME,

  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, heroName: "Absent" });
    try {
      const auto = await bot.play(60, { segmentTicks: 60 });
      bot.act(classic.ACTION.setControl, { mode: "idle" });
      const idle = await bot.play(100, { segmentTicks: 50 });
      const resyncs = auto.resyncs.length + idle.resyncs.length;
      check(
        auto.verified + idle.verified === 3 && resyncs === 0,
        `classic-offline: 160 ticks in Auto then Idle verified (${auto.verified + idle.verified} acks, resyncs ${resyncs})`,
      );
      const state: ClassicOfflineState = {
        guest,
        tick: bot.verified.tick,
        hash: bot.verified.hash,
        closedAt: 0,
        snapshot: null,
      };
      try {
        state.snapshot = bot.verifiedSnapshot();
      } catch {
        state.snapshot = null;
      }
      await bot.close();
      // The absence starts at the last verified progress, which is before this close.
      state.closedAt = Date.now();
      ctx.state.set(NAME, state);
    } catch (err) {
      await bot.close();
      throw err;
    }
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(NAME) as ClassicOfflineState | undefined;
    if (!state) {
      check(false, "classic-offline: no state from run() to resume");
      return;
    }
    // The admin tunable: set before the absence ends, so the Worker's config cache
    // (10 s) has expired by the rejoin.
    const adminToken = await devAdmin(ctx.url);
    const before = await api<TunablesBody>(ctx.url, "/api/admin/tunables", { token: adminToken });
    const original = before.body.values?.[OFFLINE_XP];
    check(
      await setOfflineXp(ctx.url, adminToken, ADMIN_XP_PCT),
      `classic-offline: the admin sets ${OFFLINE_XP} = ${ADMIN_XP_PCT} (was ${String(original)})`,
    );
    const setAt = Date.now();
    let first: VState;
    try {
      const now = Date.now();
      const wait = Math.max(state.closedAt + MIN_ABSENCE_MS - now, setAt + CONFIG_TTL_MS - now);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      // Pending play that is already verified: pendingToTick equals the verified tick.
      first = await rawJoin(ctx.url, state.guest, {
        tick: state.tick,
        hash: state.hash,
        pending: true,
        pendingToTick: state.tick,
      });
    } finally {
      const restore = typeof original === "number" ? original : DEFAULT_XP_PCT;
      check(
        await setOfflineXp(ctx.url, adminToken, restore),
        `classic-offline: ${OFFLINE_XP} restored to ${restore}`,
      );
    }
    const summary = summaryOf(first);
    check(
      first.continued === false && first.offline !== null && summary !== undefined,
      `classic-offline: a return with verified pending is granted now (continued ${first.continued}, offline ${first.offline ? "granted" : "none"})`,
    );
    if (!summary || summary.type !== "classic.offline.summary") {
      fail("classic-offline: no classic.offline.summary in the grant");
      return;
    }
    check(
      summary.xpPct === ADMIN_XP_PCT,
      `classic-offline: the grant uses the admin's ${ADMIN_XP_PCT} % offline XP (xpPct ${summary.xpPct})`,
    );
    if (!state.snapshot) {
      fail("classic-offline: the bot was not at its verified state when it closed");
    } else {
      const at50 = localGrant(state.snapshot, summary.awayMs, ADMIN_XP_PCT);
      const at20 = localGrant(state.snapshot, summary.awayMs, DEFAULT_XP_PCT);
      check(
        at50 !== null && at50.xp === summary.xp && at50.hash === first.hash,
        `classic-offline: the server's grant equals { xpPct: ${ADMIN_XP_PCT} } on the verified state (xp ${summary.xp} vs ${at50?.xp}, hash ${at50?.hash === first.hash ? "same" : "differs"})`,
      );
      // floor(b * 50 / 100) vs floor(b * 20 / 100): 2.5x up to rounding.
      check(
        at20 !== null &&
          summary.xp > 0 &&
          Math.abs(summary.xp * 2 - at20.xp * 5) <= 5 &&
          summary.xp > at20.xp,
        `classic-offline: ${ADMIN_XP_PCT} % pays 2.5x the ${DEFAULT_XP_PCT} % XP (${summary.xp} vs ${at20?.xp})`,
      );
    }
    check(
      summary.awayMs >= MIN_ABSENCE_MS && summary.ms <= summary.capMs,
      `classic-offline: away ${summary.awayMs} ms, credited ${summary.ms} ms, cap ${summary.capMs} ms`,
    );

    // Immediately again: the absence was just granted, so no second grant.
    const second = await rawJoin(ctx.url, state.guest);
    check(
      second.offline === null,
      `classic-offline: a rejoin right after the grant gets no second grant (offline ${second.offline ? "granted" : "none"})`,
    );

    // A switch of device: a join with no resume at all. It adopts the snapshot, which
    // already holds the grant, and no second summary arrives.
    const device = await rawJoin(ctx.url, state.guest);
    check(
      device.continued === false &&
        device.offline === null &&
        summaryOf(device) === undefined &&
        device.hash === first.hash,
      `classic-offline: a switch-device join after the grant adopts the granted state with no second summary (continued ${device.continued}, offline ${device.offline ? "granted" : "none"}, hash ${device.hash === first.hash ? "as granted" : "differs"})`,
    );
  },
};
