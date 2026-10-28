/**
 * HUD layout helpers (desktop, compact portrait, short landscape): toast anchors, the
 * Modes control, the short-height breakpoint, bottom-bar order and the shell hand-off
 * (classicView.ownsExitControl). Pure maths, no DOM.
 */
import { describe, expect, it } from "vite-plus/test";
import { classicView } from "../src/client/index.ts";
import {
  BOTTOM_BAR_HEIGHT,
  HUD_EDGE,
  LEFT_WIDTH,
  MINIMAP_CHIP,
  MINIMAP_SIZE,
  NO_INSETS,
  bottomBarInset,
  errorFlashStyle,
  leftColumnBottom,
  minimapBlockHeight,
  modesControlVisible,
  toastLayout,
  topRightInset,
  bottomOrderFor,
  hudLayoutFor,
  SHORT_MAX_HEIGHT,
} from "../src/client/hud/layout.ts";
import { HERO_MIN_DIAMETER, MARKER } from "../src/client/hud/widgets/Minimap.tsx";
import { SKILL_GLYPHS } from "../src/client/hud/icons.tsx";

describe("layout breakpoints", () => {
  it("desktop when the viewport is wide and at least 500 px tall", () => {
    expect(hudLayoutFor(false, 800)).toBe("desktop");
    expect(hudLayoutFor(false, SHORT_MAX_HEIGHT)).toBe("desktop");
  });

  it("phone portrait is compact; under 500 px of height it is the short layout, at any width", () => {
    expect(hudLayoutFor(true, 844)).toBe("compact");
    expect(hudLayoutFor(true, SHORT_MAX_HEIGHT - 1)).toBe("short");
    expect(hudLayoutFor(true, 375)).toBe("short");
    expect(hudLayoutFor(false, 375)).toBe("short");
  });
});

describe("minimap block", () => {
  it("desktop block ends at 226 px, so its toast anchor starts below it", () => {
    expect(HUD_EDGE + minimapBlockHeight("desktop")).toBe(226);
  });

  it("buttons sit under the canvas only where the layout has room for them", () => {
    expect(MINIMAP_SIZE.desktop.buttons).toBe(true);
    expect(MINIMAP_SIZE.compact.buttons).toBe(false);
    expect(MINIMAP_SIZE.short.buttons).toBe(true);
    expect(minimapBlockHeight("short")).toBeGreaterThan(minimapBlockHeight("compact"));
  });

  it("the top-right inset clears the minimap column in every layout", () => {
    for (const l of ["desktop", "compact", "short"] as const) {
      expect(topRightInset(l)).toBe(MINIMAP_SIZE[l].width + HUD_EDGE * 2);
    }
  });
});

describe("toast placement", () => {
  it("desktop: starts below the minimap block with the minimap shown", () => {
    const t = toastLayout("desktop", true, false);
    expect(t.visible).toBe(true);
    expect(t.max).toBe(3);
    expect(t.style.top).toBe(HUD_EDGE + minimapBlockHeight("desktop") + HUD_EDGE);
    expect(t.style.top as number).toBeGreaterThan(HUD_EDGE + minimapBlockHeight("desktop"));
  });

  it("desktop: sits under the Map chip when the minimap is hidden, never under the chip", () => {
    expect(toastLayout("desktop", false, false).style.top).toBe(HUD_EDGE * 2 + MINIMAP_CHIP);
    expect(MINIMAP_CHIP).toBeGreaterThanOrEqual(44);
  });

  it("desktop: the Dismiss button fits the 280 px toast box (no negative margins)", () => {
    const t = toastLayout("desktop", true, false);
    expect(t.style.width).toBe(280);
    expect(t.style.right).toBe(HUD_EDGE);
  });

  it("compact: above the bottom bar and clear of the left column", () => {
    const t = toastLayout("compact", true, false);
    expect(t.max).toBe(2);
    expect(t.style.bottom).toBe(BOTTOM_BAR_HEIGHT.compact + HUD_EDGE);
    expect(t.style.top).toBeUndefined();
    expect(t.style.left).toBe(LEFT_WIDTH.compact + HUD_EDGE * 2);
  });

  it("short: above the short bottom bar, centred", () => {
    const t = toastLayout("short", true, false);
    expect(t.max).toBe(2);
    expect(t.style.bottom).toBe(BOTTOM_BAR_HEIGHT.short + HUD_EDGE);
    expect(t.style.left).toBe("50%");
  });

  it("phones hide toasts while a full-screen panel is open, so they never sit over its slots", () => {
    expect(toastLayout("compact", true, true).visible).toBe(false);
    expect(toastLayout("short", true, true).visible).toBe(false);
    expect(toastLayout("desktop", true, true).visible).toBe(true);
  });
});

describe("Modes control", () => {
  it("is hidden on a phone while a panel sheet is open", () => {
    expect(modesControlVisible("compact", true)).toBe(false);
    expect(modesControlVisible("short", true)).toBe(false);
  });

  it("is always shown on desktop and whenever no phone panel is open", () => {
    expect(modesControlVisible("desktop", true)).toBe(true);
    expect(modesControlVisible("compact", false)).toBe(true);
    expect(modesControlVisible("short", false)).toBe(true);
  });
});

describe("short layout bottom bar", () => {
  it("orders XP, then the life orb, belt, skills, mana orb, and the panel row last", () => {
    expect(bottomOrderFor("short", "xp")).toBeLessThan(bottomOrderFor("short", "life"));
    expect(bottomOrderFor("short", "life")).toBeLessThan(bottomOrderFor("short", "belt"));
    expect(bottomOrderFor("short", "belt")).toBeLessThan(bottomOrderFor("short", "skill"));
    expect(bottomOrderFor("short", "skill")).toBeLessThan(bottomOrderFor("short", "mana"));
    expect(bottomOrderFor("short", "mana")).toBeLessThan(bottomOrderFor("short", "panel"));
  });

  it("keeps the compact and desktop orders unchanged", () => {
    expect(bottomOrderFor("compact", "belt")).toBeLessThan(bottomOrderFor("compact", "skill"));
    expect(bottomOrderFor("desktop", "life")).toBeLessThan(bottomOrderFor("desktop", "skill"));
  });
});

describe("minimap markers", () => {
  it("stairs, waypoints and portals are bigger than monster dots", () => {
    expect(MARKER.stairs.size).toBeGreaterThan(MARKER.monster.size);
    expect(MARKER.waypoint.size).toBeGreaterThan(MARKER.monster.size);
    expect(MARKER.portal.size).toBeGreaterThan(MARKER.monster.size);
  });

  it("stairs and waypoints have different shapes", () => {
    expect(MARKER.stairs.shape).not.toBe(MARKER.waypoint.shape);
  });
});

describe("shell hand-off", () => {
  it("classic owns its exit control, so the app shell skips its back button", () => {
    expect(classicView.ownsExitControl).toBe(true);
    expect(classicView.modeId).toBe("classic");
  });
});

describe("measured bottom bar", () => {
  it("uses the larger of the constant and the measured height", () => {
    expect(bottomBarInset("compact", 0)).toBe(BOTTOM_BAR_HEIGHT.compact);
    expect(bottomBarInset("compact", 309.2)).toBe(310);
    expect(bottomBarInset("compact", 200)).toBe(BOTTOM_BAR_HEIGHT.compact);
  });

  it("the Log column and the toasts stop above a wrapped bottom bar at every phone width", () => {
    // A 375 px phone wraps the bottom bar taller than the 270 px constant (XP row at y 503 of 812).
    const measured = 812 - 503 + 4;
    expect(leftColumnBottom("compact", { top: 0, bottom: measured })).toBeGreaterThanOrEqual(
      measured + HUD_EDGE,
    );
    expect(toastLayout("compact", true, false, measured).style.bottom).toBeGreaterThanOrEqual(
      measured + HUD_EDGE,
    );
    expect(leftColumnBottom("compact", NO_INSETS)).toBe(BOTTOM_BAR_HEIGHT.compact + HUD_EDGE);
  });

  it("the error flash sits under the top region on phones, not over the bottom bar", () => {
    const style = errorFlashStyle("compact", { top: 90, bottom: 300 });
    expect(style.top).toBe(90 + HUD_EDGE * 2);
    expect(style.bottom).toBeUndefined();
  });
});

describe("minimap legibility", () => {
  it("the hero dot is at least 10 px across on the compact minimap", () => {
    expect(HERO_MIN_DIAMETER).toBeGreaterThanOrEqual(10);
  });

  it("stations (stairs, waypoints, portals, townsfolk) are at least 8 px", () => {
    for (const kind of ["stairs", "waypoint", "portal", "npc"] as const) {
      expect(MARKER[kind].size).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("skill glyphs", () => {
  it("venom shot does not share the flame silhouette of ember bolt", () => {
    expect(SKILL_GLYPHS["classic.skill.venom_shot"]).toBeDefined();
    expect(SKILL_GLYPHS["classic.skill.venom_shot"]).not.toEqual(
      SKILL_GLYPHS["classic.skill.ember_bolt"],
    );
  });
});
