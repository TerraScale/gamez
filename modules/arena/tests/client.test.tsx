import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isOpId,
  type ArenaMatch,
  type ArenaStatus,
  type ArenaLadderResponse,
} from "@gamez/protocol";
import { fight } from "../src/index.ts";
import { ArenaReplay, ArenaScreen } from "../src/client/index.ts";
import { ArenaView, type ArenaViewProps } from "../src/client/ArenaView.tsx";
import { cameraOf, floatOffset, FLOAT_ROWS, laneLeft } from "../src/client/ArenaReplay.tsx";
import {
  classLabel,
  failureText,
  isYou,
  newArenaOpId,
  opponentOf,
  planReplay,
  resultLine,
  ticketStep,
  viewerOutcome,
  viewerSide,
  MAX_POLLS,
  POLL_MS,
} from "../src/client/model.ts";
import { build, skill } from "./helpers.ts";

const A = build({ accountId: "acc-a", name: "Alpha", displayName: "Alpha" });
const B = build({
  accountId: "acc-b",
  name: "Bravo",
  displayName: "Bravo",
  classId: "classic.rogue",
  appearance: "unit.hero.rogue",
  maxHp: 150,
  dmgMin: 6,
  dmgMax: 8,
  attackRate: 14,
  skills: [
    skill({
      id: "classic.skill.multishot",
      name: "Fan of Arrows",
      kind: "projectile",
      power: 85,
      cooldown: 10,
      range: 8,
    }),
  ],
});
const SEED = 99;

/** A match record as ArenaDO would store it, resolved by the very same fight(). */
function matchFixture(over: Partial<ArenaMatch> = {}): ArenaMatch {
  const r = fight(A, B, SEED);
  return {
    id: "m1",
    seasonId: "s1",
    at: 1,
    attacker: {
      party: { accountId: "acc-a", displayName: "Alpha" },
      classId: A.classId,
      level: A.level,
      ratingBefore: 1000,
      ratingAfter: 1016,
      ghost: false,
    },
    defender: {
      party: { accountId: "acc-b", displayName: "Bravo" },
      classId: B.classId,
      level: B.level,
      ratingBefore: 1000,
      ratingAfter: 984,
      ghost: false,
    },
    winner: r.winner,
    seed: SEED,
    builds: { attacker: A, defender: B },
    ticks: r.ticks,
    contentHash: r.contentHash,
    rewards: { coin: 10, seasonXp: 5 },
    ...over,
  };
}

const STATUS: ArenaStatus = {
  seasonId: "s1",
  rating: 1016,
  wins: 3,
  losses: 1,
  draws: 0,
  registered: true,
  fightsLeftToday: 7,
  ticket: null,
  recent: [
    {
      id: "m1",
      at: 1,
      opponent: { accountId: "acc-b", displayName: "Bravo" },
      result: "win",
      ratingDelta: 16,
      defended: false,
    },
    {
      id: "m2",
      at: 2,
      opponent: { accountId: "acc-c", displayName: "Charlie" },
      result: "loss",
      ratingDelta: -12,
      defended: true,
    },
  ],
};

const LADDER: ArenaLadderResponse = {
  seasonId: "s1",
  available: true,
  rows: [
    {
      rank: 1,
      accountId: "acc-z",
      displayName: "Zed",
      classId: "classic.sorcerer",
      level: 30,
      rating: 1400,
      wins: 9,
      losses: 1,
    },
    {
      rank: 2,
      accountId: "acc-a",
      displayName: "Alpha",
      classId: "classic.warrior",
      level: 10,
      rating: 1016,
      wins: 3,
      losses: 1,
    },
  ],
};

function viewProps(over: Partial<ArenaViewProps> = {}): ArenaViewProps {
  return {
    status: { state: "ready", value: STATUS },
    ladder: { state: "ready", value: LADDER },
    tab: "fight",
    accountId: "acc-a",
    fight: { phase: "idle", seconds: 0, message: null },
    opening: null,
    onTab: () => {},
    onFight: () => {},
    onRetry: () => {},
    onReplay: () => {},
    onClose: () => {},
    ...over,
  };
}

describe("ArenaView header", () => {
  it("shows its own title and Close standalone, and hides them when embedded in a sheet", () => {
    const alone = renderToStaticMarkup(<ArenaView {...viewProps()} />);
    expect(alone).toContain(`<div class="arena-head">`);
    const embedded = renderToStaticMarkup(<ArenaView {...viewProps({ embedded: true })} />);
    expect(embedded).not.toContain(`<div class="arena-head">`);
    expect(embedded).toContain(`class="arena-tabs"`);
  });
});

describe("replay plan", () => {
  it("is faithful for a match resolved by the same rules", () => {
    const plan = planReplay(matchFixture());
    expect(plan.faithful).toBe(true);
    expect(plan.note).toBeNull();
    expect(plan.frames.length).toBe(plan.ticks);
    expect(plan.frames.at(-1)?.tick).toBe(plan.ticks - 1);
  });

  it("shows the record with a note when the replay disagrees", () => {
    const m = matchFixture();
    const other = m.winner === "attacker" ? "defender" : "attacker";
    const plan = planReplay({ ...m, winner: other });
    expect(plan.faithful).toBe(false);
    expect(plan.winner).toBe(other);
    expect(plan.note).toContain("does not match");
  });

  it("shows the result only when the arena rules changed (contentHash differs)", () => {
    const plan = planReplay(matchFixture({ contentHash: "0000000000000000" }));
    expect(plan.frames).toEqual([]);
    expect(plan.faithful).toBe(false);
    expect(plan.note).toContain("rules changed");
  });
});

describe("viewer helpers", () => {
  it("finds the viewer's side and the outcome from it", () => {
    const m = matchFixture({ winner: "attacker" });
    expect(viewerSide(m, "acc-a")).toBe("attacker");
    expect(viewerSide(m, "acc-b")).toBe("defender");
    expect(viewerSide(m, "nobody")).toBeNull();
    expect(viewerOutcome("attacker", "attacker")).toBe("win");
    expect(viewerOutcome("attacker", "defender")).toBe("loss");
    expect(viewerOutcome("draw", "attacker")).toBe("draw");
    expect(viewerOutcome("attacker", null)).toBe("draw");
    expect(resultLine("attacker", "attacker")).toBe("You win");
    expect(resultLine("attacker", "defender")).toBe("You lose");
    expect(resultLine("draw", "defender")).toBe("Draw");
    expect(resultLine("defender", null)).toBe("Defender wins");
    expect(opponentOf(m, "acc-a").accountId).toBe("acc-b");
    expect(opponentOf(m, "acc-b").accountId).toBe("acc-a");
  });

  it("labels classes and marks the viewer in the ladder", () => {
    expect(classLabel("classic.warrior")).toBe("Warrior");
    expect(classLabel("")).toBe("");
    expect(isYou("acc-a", "acc-a")).toBe(true);
    expect(isYou("", "")).toBe(false);
    expect(isYou("acc-a", "acc-b")).toBe(false);
  });
});

describe("queue polling", () => {
  it("waits, matches or fails from a ticket", () => {
    expect(ticketStep({ ticket: "t", status: "waiting", match: null, reason: null })).toEqual({
      kind: "wait",
    });
    const m = matchFixture();
    expect(ticketStep({ ticket: "t", status: "matched", match: m, reason: null })).toEqual({
      kind: "matched",
      match: m,
    });
    expect(ticketStep({ ticket: "t", status: "failed", match: null, reason: "no_build" })).toEqual({
      kind: "failed",
      reason: "no_build",
    });
    expect(ticketStep({ ticket: "t", status: "failed", match: null, reason: null })).toEqual({
      kind: "failed",
      reason: "no_opponent",
    });
  });

  it("polls once a second for at most MAX_POLLS", () => {
    expect(POLL_MS).toBe(1000);
    expect(MAX_POLLS).toBeGreaterThan(30);
  });

  it("has a message for each failure code and makes valid op ids", () => {
    expect(failureText("no_build")).toContain("Play classic");
    expect(failureText("limit")).toContain("tomorrow");
    expect(failureText("who knows")).toContain("could not start");
    for (let i = 0; i < 5; i++) expect(isOpId(newArenaOpId())).toBe(true);
  });
});

describe("ArenaView", () => {
  it("renders the loading state", () => {
    const html = renderToStaticMarkup(
      <ArenaView {...viewProps({ status: { state: "loading" } })} />,
    );
    expect(html).toContain("Loading the arena");
  });

  it("renders the unavailable state (the arena is not open yet)", () => {
    const html = renderToStaticMarkup(
      <ArenaView {...viewProps({ status: { state: "unavailable" } })} />,
    );
    expect(html).toContain("not open yet");
  });

  it("renders the error state with a retry button", () => {
    const html = renderToStaticMarkup(
      <ArenaView {...viewProps({ status: { state: "error", message: "Network is down" } })} />,
    );
    expect(html).toContain("Network is down");
    expect(html).toContain("Try again");
  });

  it("renders rating, record, fights left and recent matches with replay buttons", () => {
    const html = renderToStaticMarkup(<ArenaView {...viewProps()} />);
    expect(html).toContain("1016");
    expect(html).toContain("Left today");
    expect(html).toContain("vs Bravo");
    expect(html).toContain("vs Charlie");
    expect(html).toContain("(defended)");
    expect(html.match(/>Replay</g)?.length).toBe(2);
    expect(html).toMatch(/<button[^>]*arena-primary[^>]*>Fight<\/button>/);
  });

  it("renders the empty recent state and a searching button", () => {
    const html = renderToStaticMarkup(
      <ArenaView
        {...viewProps({
          status: {
            state: "ready",
            value: { ...STATUS, recent: [], registered: false, fightsLeftToday: 0 },
          },
          fight: { phase: "waiting", seconds: 3, message: null },
        })}
      />,
    );
    expect(html).toContain("No fights yet");
    expect(html).toContain("Searching... 3 s");
    expect(html).toContain("joins the ghost pool");
    expect(html).toContain("disabled");
  });

  it("shows the fight failure message", () => {
    const html = renderToStaticMarkup(
      <ArenaView
        {...viewProps({ fight: { phase: "idle", seconds: 0, message: "No opponent was found." } })}
      />,
    );
    expect(html).toContain("No opponent was found.");
  });

  it("renders the ladder with the viewer's row marked", () => {
    const html = renderToStaticMarkup(<ArenaView {...viewProps({ tab: "ladder" })} />);
    expect(html).toContain("Zed");
    expect(html).toMatch(/arena-row arena-you[^>]*>[\s\S]*Alpha \(you\)/);
    expect(html.match(/class="arena-row arena-you"/g)?.length).toBe(1);
  });

  it("renders the ladder states: unavailable, empty", () => {
    const off = renderToStaticMarkup(
      <ArenaView
        {...viewProps({
          tab: "ladder",
          ladder: { state: "ready", value: { ...LADDER, available: false, rows: [] } },
        })}
      />,
    );
    expect(off).toContain("ladder is not open yet");
    const none = renderToStaticMarkup(
      <ArenaView
        {...viewProps({
          tab: "ladder",
          ladder: { state: "ready", value: { ...LADDER, rows: [] } },
        })}
      />,
    );
    expect(none).toContain("No ranked heroes yet");
  });
});

describe("ArenaReplay", () => {
  it("renders the first frame with both fighters and their hp bars", () => {
    const m = matchFixture();
    const html = renderToStaticMarkup(<ArenaReplay match={m} viewerId="acc-a" />);
    expect(html).toContain("Alpha (you)");
    expect(html).toContain("Bravo");
    // The replay starts playing on mount, so the first control is Pause.
    expect(html).toContain("Pause");
    expect(html).toContain("Skip to result");
    expect(html).toContain('role="meter"');
  });

  it("shows the result note when the rules changed", () => {
    const html = renderToStaticMarkup(
      <ArenaReplay match={matchFixture({ contentHash: "0000000000000000" })} viewerId="acc-b" />,
    );
    expect(html).toContain("rules changed");
    // No frames: the banner shows the recorded result from the viewer's side (bravo is the defender).
    // The fixture's winner comes from fight(), so the expected banner follows it.
    expect(html).toContain(matchFixture().winner === "defender" ? "You win" : "You lose");
  });
});

describe("ArenaScreen", () => {
  it("renders the loading state before its requests answer", () => {
    const html = renderToStaticMarkup(
      <ArenaScreen platform={{} as never} accountId="acc-a" onClose={() => {}} />,
    );
    expect(html).toContain("Loading the arena");
  });
});

describe("replay floating numbers", () => {
  it("stacks consecutive numbers of one fighter on distinct rows", () => {
    const rows = Array.from({ length: FLOAT_ROWS }, (_, n) => floatOffset(n));
    expect(new Set(rows.map((r) => r.bottom)).size).toBe(FLOAT_ROWS);
    // Neighbours also shift sideways, so even a wrapped row does not print exactly on top.
    expect(floatOffset(0).marginLeft).not.toBe(floatOffset(1).marginLeft);
    expect(floatOffset(FLOAT_ROWS)).toEqual(floatOffset(0));
  });
});

describe("replay camera", () => {
  it("frames both fighters and keeps melee range wide enough for the avatars", () => {
    const melee = cameraOf(100, 110);
    expect(melee.span).toBe(80);
    // One tile (10 tenths) is 12.5 % of the lane at melee range.
    expect(laneLeft(110, melee)).not.toBe(laneLeft(100, melee));
    const far = cameraOf(40, 160);
    expect(far.span).toBe(180);
    // Lane 10..190 tenths is the camera window: 40 sits at 16.67 %, 160 at 83.33 %.
    expect(laneLeft(40, far)).toBe("16.67%");
    expect(laneLeft(160, far)).toBe("83.33%");
  });
});
