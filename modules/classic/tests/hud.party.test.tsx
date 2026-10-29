/**
 * Party HUD (docs/design/party.md §10): party frames, the Party panel (roster, recruit, slots, AI
 * options), the death banner and the party-aware death screen, control bar label and panel buttons.
 * Rendered with react-dom/server and a fake ClassicClientApi (no DOM in the test runner), so click
 * targets are checked through their pure action builders (controlCall, reorderOrder, spreadPatch).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import type {
  ClassicClientApi,
  HudSnapshot,
  PartyMemberView,
  PartyView,
  Store,
  UiState,
} from "../src/client/contract.ts";
import {
  PartyFrames,
  controlCall,
  frameLabel,
  CONTROL_GOLD,
  PARTY_CYAN,
} from "../src/client/hud/widgets/PartyFrames.tsx";
import {
  PartyPanel,
  memberStatusText,
  recruitBlockedText,
  reorderOrder,
  spreadPatch,
} from "../src/client/hud/panels/PartyPanel.tsx";
import { DeathScreen, deathInfoOf } from "../src/client/hud/widgets/DeathScreen.tsx";
import { ControlBar } from "../src/client/hud/widgets/ControlBar.tsx";
import {
  PanelButtons,
  PARTY_BUTTON,
  buildMoreItems,
} from "../src/client/hud/widgets/PanelButtons.tsx";
import { ALL_PANEL_IDS, SLOT, deathBannerTop } from "../src/client/hud/layout.ts";
import { DEFAULT_WIDGETS, PANEL_COMPONENTS } from "../src/client/hud/index.tsx";
import { fmtInt } from "../src/client/hud/format.ts";
import { DEFAULT_PARTY_CONFIG } from "../src/resources.ts";

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function member(
  over: Partial<PartyMemberView> & { entity: number; slot: number; name: string },
): PartyMemberView {
  return {
    key: `F${over.slot + 1}`,
    classId: "classic.warrior",
    className: "Warrior",
    appearance: "unit.hero.warrior",
    tint: 0xb07a3a,
    level: 9,
    xpPermille: 250,
    life: 80,
    lifeMax: 100,
    mana: 20,
    manaMax: 40,
    role: "front",
    dead: false,
    reviving: null,
    controlled: false,
    leader: false,
    founder: false,
    plan: "none",
    unspent: 0,
    statuses: [],
    ...over,
  };
}

function party(over: Partial<PartyView> = {}, members: PartyMemberView[] = []): PartyView {
  return {
    members,
    slots: 4,
    maxMembers: 4,
    nextSlotPrice: null,
    nextSlotBossDepth: null,
    recruit: { level: 6, fee: 300, blocked: null },
    config: { ...DEFAULT_PARTY_CONFIG },
    gold: 5000,
    inTown: true,
    partyAuto: false,
    ...over,
  };
}

const THREE: PartyMemberView[] = [
  member({ entity: 1, slot: 0, name: "Ada", founder: true, leader: false }),
  member({
    entity: 2,
    slot: 1,
    name: "Bo",
    className: "Rogue",
    classId: "classic.rogue",
    controlled: true,
    leader: true,
  }),
  member({
    entity: 3,
    slot: 2,
    name: "Cy",
    className: "Sorcerer",
    classId: "classic.sorcerer",
    role: "back",
  }),
];

function makeApi(
  opts: {
    party?: PartyView | null;
    hero?: Partial<HudSnapshot["hero"]> | null;
    compact?: boolean;
    phase?: "choose" | "play";
    control?: Partial<HudSnapshot["control"]>;
    acts?: { name: string; payload: unknown }[];
  } = {},
): ClassicClientApi {
  const acts = opts.acts ?? [];
  const hud = {
    phase: opts.phase ?? "play",
    classes: [
      { id: "classic.warrior", name: "Warrior", description: "Front line." },
      { id: "classic.rogue", name: "Rogue", description: "Quick and sharp." },
    ],
    hero:
      opts.hero === null
        ? null
        : { dead: false, respawnIn: 0, level: 9, gold: 5000, name: "Ada", ...opts.hero },
    skills: [],
    party: opts.party === undefined ? null : opts.party,
    control: {
      mode: "manual",
      speed: 1,
      config: {},
      overridden: false,
      plan: "none",
      ...opts.control,
    },
  } as unknown as HudSnapshot;
  const ui = {
    panels: [],
    toasts: [],
    compact: opts.compact ?? false,
    error: null,
    settings: {},
  } as unknown as UiState;
  return {
    hud: staticStore(hud),
    log: staticStore([]),
    ui: staticStore(ui),
    act: (name: string, payload: unknown) => {
      acts.push({ name, payload });
      return { ok: true, events: [], tick: 0 };
    },
    togglePanel() {},
    openPanel() {},
    closePanel() {},
    closeAll() {},
    setHover() {},
    updateSettings() {},
    dismissToast() {},
    minimap: () => null,
    castSlot() {},
    drink() {},
    newGame() {},
    exit() {},
  } as unknown as ClassicClientApi;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

describe("party frames", () => {
  it("renders one frame per member with the controlled border gold and the others cyan", () => {
    const html = renderToStaticMarkup(
      <PartyFrames api={makeApi({ party: party({ partyAuto: true }, THREE) })} />,
    );
    expect(html).toContain('aria-label="Ada, Warrior, level 9"');
    expect(html).toContain('aria-label="Bo, Rogue, level 9, controlled"');
    expect(html).toContain('aria-label="Cy, Sorcerer, level 9"');
    expect(html.split(`border:2px solid ${CONTROL_GOLD}`)).toHaveLength(2);
    expect(html.split(`border:2px solid ${PARTY_CYAN}`)).toHaveLength(3);
    expect(CONTROL_GOLD).toBe("#ffd24a");
    expect(PARTY_CYAN).toBe("#4fd8ff");
    // "Party: Auto" lives in the control bar only (one entry point for the setting).
    expect(html).not.toContain("Party: Auto");
    expect(html).toContain('aria-label="Open party panel"');
  });

  it("shows the hotkey of each frame and the Party header on the desktop", () => {
    const html = renderToStaticMarkup(<PartyFrames api={makeApi({ party: party({}, THREE) })} />);
    expect(html).toContain(">F1<");
    expect(html).toContain(">F3<");
    expect(html).not.toContain("Party: Manual");
    expect(html).toContain('aria-label="Open party panel"');
    expect(html).toContain("width:200px");
  });

  it("shows a downed skull and the revive progress on the frame", () => {
    const downed = [
      THREE[0]!,
      member({ ...THREE[1]!, controlled: false, leader: false }),
      member({
        entity: 3,
        slot: 2,
        name: "Cy",
        className: "Sorcerer",
        classId: "classic.sorcerer",
        dead: true,
        reviving: { by: 1, pct: 40 },
      }),
    ];
    const html = renderToStaticMarkup(<PartyFrames api={makeApi({ party: party({}, downed) })} />);
    expect(html).toContain('aria-label="Cy, Sorcerer, level 9, downed, being revived 40%"');
    expect(html).toContain('aria-label="Revive progress"');
  });

  it("is hidden for a party of one with no free slot", () => {
    const solo = [member({ entity: 1, slot: 0, name: "Ada", controlled: true, founder: true })];
    const html = renderToStaticMarkup(
      <PartyFrames api={makeApi({ party: party({ slots: 1 }, solo) })} />,
    );
    expect(html).toBe("");
  });

  it("offers a + Party button for a party of one once a second slot is open", () => {
    const solo = [member({ entity: 1, slot: 0, name: "Ada", controlled: true, founder: true })];
    const html = renderToStaticMarkup(
      <PartyFrames api={makeApi({ party: party({ slots: 2 }, solo) })} />,
    );
    expect(html).toContain("+ Party");
    expect(html).toContain('aria-label="Add a party member"');
  });

  it("compact frames are touch targets of at least 44 px and nothing is wider than 375 px", () => {
    const html = renderToStaticMarkup(
      <PartyFrames api={makeApi({ party: party({ partyAuto: true }, THREE), compact: true })} />,
    );
    expect(html).toContain("min-height:44px");
    expect(html).toContain("min-width:44px");
    expect(html).not.toContain("width:200px");
    const widths = [...html.matchAll(/(?:^|;|")\s*width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const w of widths) expect(w).toBeLessThanOrEqual(375);
  });

  it("the click target of a frame is control of that member, and nothing for the controlled one", () => {
    expect(controlCall(THREE[1]!)).toBeNull();
    expect(controlCall(THREE[2]!)).toEqual({ name: ACTION.partyControl, payload: { hero: 3 } });
    expect(ACTION.partyControl).toBe("classic.party.control");
  });

  it("a frame click on a downed member revives it instead of taking control of the corpse", () => {
    const downed = member({ ...THREE[2]!, dead: true });
    const members = [THREE[0]!, THREE[1]!, downed];
    expect(controlCall(downed, members)).toEqual({
      name: ACTION.interact,
      payload: { target: 3 },
    });
    const allDown = members.map((m) => member({ ...m, dead: true }));
    expect(controlCall(allDown[2]!, allDown)).toBeNull();
    const html = renderToStaticMarkup(<PartyFrames api={makeApi({ party: party({}, members) })} />);
    expect(html).toContain("Downed: click or F3 to revive");
  });

  it("compact frames show each member's name and level (two Warriors stay apart)", () => {
    const twins = [
      member({ entity: 1, slot: 0, name: "Ada", controlled: true, founder: true, level: 7 }),
      member({ entity: 2, slot: 1, name: "Warrior 3", level: 4 }),
    ];
    const html = renderToStaticMarkup(
      <PartyFrames api={makeApi({ party: party({}, twins), compact: true })} />,
    );
    expect(html).toContain('data-party-name="0"');
    expect(html).toContain(">Ada<");
    expect(html).toContain(">Warrior 3<");
    expect(html).toContain(">7<");
    expect(html).toContain(">4<");
  });

  it("labels a frame with its state", () => {
    expect(frameLabel(THREE[1]!)).toBe("Bo, Rogue, level 9, controlled");
    expect(frameLabel(THREE[0]!)).toBe("Ada, Warrior, level 9");
  });
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

describe("party panel", () => {
  it("lists the roster, without a dismiss button for the founder", () => {
    const html = renderToStaticMarkup(
      <PartyPanel api={makeApi({ party: party({ inTown: true }, THREE) })} />,
    );
    expect(html).toContain('aria-label="F1 Ada"');
    expect(html).toContain('aria-label="F3 Cy"');
    expect(html).not.toContain('aria-label="Dismiss Ada"');
    expect(html).toContain('aria-label="Dismiss Bo"');
    expect(html).toContain("3 of 4 slots");
  });

  it("disables dismiss outside town and control of the controlled hero", () => {
    const html = renderToStaticMarkup(
      <PartyPanel api={makeApi({ party: party({ inTown: false }, THREE) })} />,
    );
    expect(html).toMatch(/aria-label="Dismiss Bo"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Take control of Bo"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Take control of Cy"[^>]*disabled/);
  });

  it("disables the recruit with the reason when blocked", () => {
    const html = renderToStaticMarkup(
      <PartyPanel
        api={makeApi({
          party: party({ inTown: false, recruit: { level: 6, fee: 300, blocked: "town" } }, THREE),
        })}
      />,
    );
    expect(html).toMatch(/aria-label="Recruit"[^>]*disabled/);
    expect(html).toContain("Recruits join you in town");
    expect(html).toContain("Starts at level 6 for 300 gold.");
  });

  it("enables the recruit when possible", () => {
    const html = renderToStaticMarkup(
      <PartyPanel
        api={makeApi({
          party: party({ slots: 4, recruit: { level: 6, fee: 300, blocked: null } }, THREE),
        })}
      />,
    );
    expect(html).not.toMatch(/aria-label="Recruit"[^>]*disabled/);
    expect(html).toContain('aria-label="New hero name"');
  });

  it("shows the next boss or the gold price of the next slot", () => {
    const boss = renderToStaticMarkup(
      <PartyPanel
        api={makeApi({
          party: party(
            { slots: 1, nextSlotPrice: 1500, nextSlotBossDepth: 4, gold: 100 },
            THREE.slice(0, 1),
          ),
        })}
      />,
    );
    expect(boss).toContain("Free when you defeat the boss on depth 4.");
    expect(boss).toContain(`Buy for ${fmtInt(1500)} gold`);
    expect(boss).toMatch(/aria-label="Buy the next party slot"[^>]*disabled/);
    const rich = renderToStaticMarkup(
      <PartyPanel
        api={makeApi({
          party: party(
            { slots: 2, nextSlotPrice: 7500, nextSlotBossDepth: 8, gold: 9000 },
            THREE.slice(0, 2),
          ),
        })}
      />,
    );
    expect(rich).not.toMatch(/aria-label="Buy the next party slot"[^>]*disabled/);
  });

  it("shows the party AI options with the current formation and toggles", () => {
    const html = renderToStaticMarkup(
      <PartyPanel
        api={makeApi({
          party: party(
            { config: { ...DEFAULT_PARTY_CONFIG, formation: "line", spread: 3, focusFire: false } },
            THREE,
          ),
        })}
      />,
    );
    expect(html).toMatch(/aria-label="Line formation"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Wedge formation"[^>]*aria-pressed="false"/);
    expect(html).toContain("Focus fire: off");
    expect(html).toContain("Revive: on");
    expect(html).toContain("Auto-switch: on");
    expect(html).toContain('aria-label="Spread value"');
  });

  it("reorders, spreads and status texts via pure helpers", () => {
    expect(reorderOrder([1, 2, 3], 0, -1)).toBeNull();
    expect(reorderOrder([1, 2, 3], 2, 1)).toBeNull();
    expect(reorderOrder([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(reorderOrder([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(spreadPatch(1, -1)).toEqual({ spread: 1 });
    expect(spreadPatch(4, 1)).toEqual({ spread: 4 });
    expect(spreadPatch(2, 1)).toEqual({ spread: 3 });
    expect(memberStatusText(THREE[1]!)).toBe("Controlled");
    expect(memberStatusText(member({ entity: 9, slot: 3, name: "Dee", dead: true }))).toBe(
      "Downed",
    );
    expect(
      memberStatusText(member({ entity: 9, slot: 3, name: "Dee", unspent: 2, plan: "fight" })),
    ).toBe("Fighting · 2 to spend");
  });

  it("explains each recruit blocker in words", () => {
    expect(
      recruitBlockedText(party({ recruit: { level: 6, fee: 300, blocked: null } })),
    ).toBeNull();
    expect(
      recruitBlockedText(party({ recruit: { level: 6, fee: 300, blocked: "town" } })),
    ).toContain("in town");
    expect(
      recruitBlockedText(
        party({ slots: 2, recruit: { level: 6, fee: 300, blocked: "slots" } }, THREE),
      ),
    ).toContain("unlocked slots are taken");
    expect(
      recruitBlockedText(party({ gold: 10, recruit: { level: 6, fee: 300, blocked: "gold" } })),
    ).toContain("Costs 300 gold. You have 10.");
  });
});

// ---------------------------------------------------------------------------
// Death banner and screen
// ---------------------------------------------------------------------------

describe("death views", () => {
  const dead = { dead: true, respawnIn: 0, level: 9, gold: 120, name: "Bo" };

  it("is null while the controlled hero is alive", () => {
    expect(deathInfoOf({ hero: { ...dead, dead: false }, party: null })).toBeNull();
    expect(deathInfoOf({ hero: null, party: null })).toBeNull();
  });

  it("solo: the death screen, unchanged", () => {
    const html = renderToStaticMarkup(<DeathScreen api={makeApi({ hero: dead, party: null })} />);
    expect(html).toContain('aria-label="You died"');
    expect(html).toContain("Level 9 · 120 gold");
    expect(html).toContain("Respawn");
  });

  it("party with a standing member: a slim banner that names the key to take control", () => {
    const downed = [
      member({ entity: 1, slot: 0, name: "Ada", founder: true }),
      member({ entity: 2, slot: 1, name: "Bo", controlled: true, dead: true }),
    ];
    const html = renderToStaticMarkup(
      <DeathScreen api={makeApi({ hero: { ...dead, respawnIn: 30 }, party: party({}, downed) })} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Bo is down");
    expect(html).toContain("F1 takes control");
    expect(html).toContain("Respawn party in town");
    expect(html).not.toContain('role="alertdialog"');
    // QA: the banner sat at top:8 over the Manual / Party: Auto / Idle buttons.
    expect(html).not.toContain("top:8px");
  });

  it("the slim banner sits under the measured top region (the control bar)", () => {
    expect(deathBannerTop({ top: 52, bottom: 120 })).toBe(52 + 16);
    expect(deathBannerTop({ top: 0, bottom: 0 })).toBeGreaterThan(8);
  });

  it("a wipe: the full screen says the party has fallen", () => {
    const wiped = [
      member({ entity: 1, slot: 0, name: "Ada", founder: true, dead: true }),
      member({ entity: 2, slot: 1, name: "Bo", controlled: true, dead: true }),
    ];
    const html = renderToStaticMarkup(
      <DeathScreen api={makeApi({ hero: dead, party: party({}, wiped) })} />,
    );
    expect(html).toContain('aria-label="Your party has fallen"');
    expect(html).toContain("Your party has fallen");
    expect(html).toContain("Respawn");
  });
});

// ---------------------------------------------------------------------------
// Control bar, panel buttons and the slot table
// ---------------------------------------------------------------------------

describe("control bar and panel buttons", () => {
  it("labels Auto as Party: Auto with a party of two or more", () => {
    const html = renderToStaticMarkup(
      <ControlBar
        api={makeApi({ party: party({}, THREE), control: { mode: "auto", plan: "explore" } })}
      />,
    );
    expect(html).toContain("Party: Auto");
    expect(html).not.toContain(">Auto<");
  });

  it("keeps the plain Auto label for a solo hero", () => {
    const solo = [member({ entity: 1, slot: 0, name: "Ada", controlled: true, founder: true })];
    const html = renderToStaticMarkup(
      <ControlBar api={makeApi({ party: party({ slots: 1 }, solo), control: { mode: "auto" } })} />,
    );
    expect(html).toContain(">Auto<");
  });

  it("the Party panel is on the desktop bar and in the phone More menu", () => {
    const html = renderToStaticMarkup(<PanelButtons api={makeApi({ party: party({}, THREE) })} />);
    expect(html).toContain(`aria-label="${PARTY_BUTTON.title}"`);
    const api = makeApi({ party: party({}, THREE) });
    expect(buildMoreItems(api, [], false).some((i) => i.id === "party")).toBe(true);
  });

  it("the party panel is registered in the layout and the slot table", () => {
    expect(ALL_PANEL_IDS).toContain("party");
    expect(PANEL_COMPONENTS.party).toBe(PartyPanel);
    const frames = DEFAULT_WIDGETS.find((w) => w.id === "classic.partyFrames");
    expect(frames?.slot).toBe(SLOT.left);
    expect(frames?.order).toBe(5);
    expect(frames?.component).toBe(PartyFrames);
  });
});
