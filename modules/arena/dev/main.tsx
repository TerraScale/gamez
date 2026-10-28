/**
 * Arena dev harness (OWNER: T-arena-sim). Renders the arena client with two
 * sample builds and local fixtures; no server involved.
 *
 *   ?view=replay (default)  ArenaReplay of a sample fight (play, skip, result)
 *   ?view=screen            ArenaScreen with a fake platform.arena (status, ladder, queue)
 *   ?view=screen&state=unavailable | error | empty   the other screen states
 *   ?seed=<n>               fight seed (default 7)
 */
import { createRoot } from "react-dom/client";
import type {
  ArenaBuild,
  ArenaLadderResponse,
  ArenaMatch,
  ArenaStatus,
  ArenaTicket,
} from "@gamez/protocol";
import type { ApiResult, ArenaApi, PlatformServices } from "@gamez/ui-host";
import { fight } from "../src/index.ts";
import { ArenaReplay, ArenaScreen } from "../src/client/index.ts";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "replay";
const state = params.get("state") ?? "ready";
const seed = Number(params.get("seed") ?? "7");

const WARRIOR: ArenaBuild = {
  mode: "classic",
  accountId: "acc-you",
  name: "Brann",
  displayName: "Brann",
  classId: "classic.warrior",
  level: 12,
  appearance: "unit.hero.warrior",
  maxHp: 240,
  dmgMin: 9,
  dmgMax: 15,
  attackRate: 14,
  armor: 18,
  resist: 10,
  critPct: 8,
  moveSpeed: 4,
  skills: [
    {
      id: "classic.skill.cleave",
      name: "Cleave",
      kind: "strike",
      power: 150,
      cooldown: 12,
      range: 2,
    },
    {
      id: "classic.skill.rally",
      name: "Rallying Cry",
      kind: "shield",
      power: 25,
      cooldown: 150,
      range: 0,
    },
  ],
  power: 52,
  sourceHash: "dev",
};

const ROGUE: ArenaBuild = {
  ...WARRIOR,
  accountId: "acc-rival",
  name: "Sable",
  displayName: "Sable",
  classId: "classic.rogue",
  appearance: "unit.hero.rogue",
  maxHp: 190,
  dmgMin: 8,
  dmgMax: 13,
  attackRate: 18,
  armor: 9,
  resist: 15,
  critPct: 14,
  moveSpeed: 5,
  skills: [
    {
      id: "classic.skill.multishot",
      name: "Fan of Arrows",
      kind: "projectile",
      power: 85,
      cooldown: 10,
      range: 8,
    },
    { id: "classic.skill.mend", name: "Mend", kind: "heal", power: 20, cooldown: 100, range: 0 },
  ],
  power: 44,
};

function sampleMatch(): ArenaMatch {
  const r = fight(WARRIOR, ROGUE, seed);
  return {
    id: `dev-${seed}`,
    seasonId: "dev",
    at: 0,
    attacker: {
      party: { accountId: "acc-you", displayName: "Brann" },
      classId: WARRIOR.classId,
      level: WARRIOR.level,
      ratingBefore: 1000,
      ratingAfter: 1000,
      ghost: false,
    },
    defender: {
      party: { accountId: "acc-rival", displayName: "Sable" },
      classId: ROGUE.classId,
      level: ROGUE.level,
      ratingBefore: 1000,
      ratingAfter: 1000,
      ghost: false,
    },
    winner: r.winner,
    seed,
    builds: { attacker: WARRIOR, defender: ROGUE },
    ticks: r.ticks,
    contentHash: r.contentHash,
    rewards: { coin: 0, seasonXp: 0 },
  };
}

const STATUS: ArenaStatus = {
  seasonId: "dev",
  rating: 1034,
  wins: 4,
  losses: 2,
  draws: 1,
  registered: true,
  fightsLeftToday: 6,
  ticket: null,
  recent: [
    {
      id: "dev-7",
      at: 3,
      opponent: { accountId: "acc-rival", displayName: "Sable" },
      result: "win",
      ratingDelta: 16,
      defended: false,
    },
    {
      id: "dev-8",
      at: 2,
      opponent: { accountId: "acc-x", displayName: "Morrow" },
      result: "loss",
      ratingDelta: -11,
      defended: true,
    },
    {
      id: "dev-9",
      at: 1,
      opponent: { accountId: "acc-y", displayName: "Vesna" },
      result: "draw",
      ratingDelta: 0,
      defended: false,
    },
  ],
};

const LADDER: ArenaLadderResponse = {
  seasonId: "dev",
  available: true,
  rows: [
    {
      rank: 1,
      accountId: "acc-z",
      displayName: "Zed",
      classId: "classic.sorcerer",
      level: 30,
      rating: 1410,
      wins: 19,
      losses: 4,
    },
    {
      rank: 2,
      accountId: "acc-you",
      displayName: "Brann",
      classId: "classic.warrior",
      level: 12,
      rating: 1034,
      wins: 4,
      losses: 2,
    },
    {
      rank: 3,
      accountId: "acc-rival",
      displayName: "Sable",
      classId: "classic.rogue",
      level: 14,
      rating: 1001,
      wins: 3,
      losses: 3,
    },
  ],
};

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const fail = (code: string): ApiResult<never> => ({ ok: false, code, message: code });

function fakeArena(): ArenaApi | undefined {
  if (state === "unavailable") {
    const u = async () => fail("unavailable");
    return { status: u, queue: u, poll: u, ladder: u, match: u } as unknown as ArenaApi;
  }
  if (state === "error") {
    const e = async () =>
      ({
        ok: false,
        code: "internal",
        message: "The arena is catching its breath. Try again.",
      }) as const;
    return { status: e, queue: e, poll: e, ladder: e, match: e } as unknown as ArenaApi;
  }
  let status: ArenaStatus =
    state === "empty" ? { ...STATUS, recent: [], registered: false, fightsLeftToday: 0 } : STATUS;
  let polls = 0;
  const match = sampleMatch();
  return {
    async status() {
      return ok(status);
    },
    async queue(): Promise<ApiResult<ArenaTicket>> {
      polls = 0;
      return ok({ ticket: "t-dev", status: "waiting", match: null, reason: null });
    },
    async poll(): Promise<ApiResult<ArenaTicket>> {
      polls++;
      if (polls < 3) return ok({ ticket: "t-dev", status: "waiting", match: null, reason: null });
      status = { ...status, fightsLeftToday: status.fightsLeftToday - 1 };
      return ok({ ticket: "t-dev", status: "matched", match, reason: null });
    },
    async ladder() {
      return ok(LADDER);
    },
    async match() {
      return ok(match);
    },
  };
}

const host = document.getElementById("host");
if (!host) throw new Error("missing #host");
const root = createRoot(host);

if (view === "screen") {
  const platform = { arena: fakeArena() } as unknown as PlatformServices;
  root.render(<ArenaScreen platform={platform} accountId="acc-you" onClose={() => {}} />);
} else {
  root.render(<ArenaReplay match={sampleMatch()} viewerId="acc-you" />);
}
