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
  PANEL_ROW_RIGHT,
  TOAST_WIDTH,
  tipLayout,
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

describe("toasts never cover open panels (QA major 2)", () => {
  // A toast box sits HUD_EDGE from the right edge and is TOAST_WIDTH wide (desktop).
  const toastLeft = (width: number) => width - HUD_EDGE - TOAST_WIDTH;
  // The panel row ends at PANEL_ROW_RIGHT from the right edge.
  const rowRight = (width: number) => width - PANEL_ROW_RIGHT.desktop;

  it("the desktop panel row ends at least HUD_EDGE left of the toast column, at every common width", () => {
    for (const width of [1024, 1280, 1366, 1440, 1600, 1920]) {
      expect(rowRight(width)).toBeLessThanOrEqual(toastLeft(width) - HUD_EDGE);
    }
  });

  it("the reserve is the toast column plus its gap on both sides (no magic number)", () => {
    expect(PANEL_ROW_RIGHT.desktop).toBe(TOAST_WIDTH + HUD_EDGE * 2);
    expect(PANEL_ROW_RIGHT.compact).toBe(0);
    expect(PANEL_ROW_RIGHT.short).toBe(0);
  });

  it("the desktop toast column stays where it was (top right, under the minimap)", () => {
    const t = toastLayout("desktop", true, true);
    expect(t.style.right).toBe(HUD_EDGE);
    expect(t.style.width).toBe(TOAST_WIDTH);
    expect(t.visible).toBe(true);
  });

  it("the error flash moves to the sheet foot while a phone panel covers the top region", () => {
    const style = errorFlashStyle("compact", { top: 90, bottom: 300 }, true);
    expect(style.top).toBeUndefined();
    expect(style.bottom).toBe(HUD_EDGE * 2);
    expect(errorFlashStyle("desktop", NO_INSETS)).toEqual({ bottom: 190 });
  });

  it("the desktop error flash moves into the toast column while a panel is open", () => {
    const style = errorFlashStyle("desktop", NO_INSETS, true);
    expect(style.right).toBe(HUD_EDGE);
    expect(style.width).toBe(TOAST_WIDTH);
    expect(style.transform).toBe("none");
    // Panels end PANEL_ROW_RIGHT from the right edge, left of this column.
    expect(PANEL_ROW_RIGHT.desktop).toBeGreaterThanOrEqual(TOAST_WIDTH + HUD_EDGE);
  });
});

describe("onboarding tip placement", () => {
  it("desktop: bottom-right corner above the measured bottom bar, never over a panel", () => {
    const insets = { top: 0, bottom: 200 };
    const t = tipLayout("desktop", insets, false, false);
    expect(t).not.toBeNull();
    expect(t?.right).toBe(HUD_EDGE);
    expect(t?.left).toBeUndefined();
    expect(t?.bottom).toBe(bottomBarInset("desktop", 200) + HUD_EDGE + 4);
    expect(tipLayout("desktop", insets, true, false)).toBeNull();
  });

  it("phones: under the top region, clear of the minimap column, and gives way to toasts", () => {
    const low = { top: 40, bottom: 310 };
    const t = tipLayout("compact", low, false, false);
    expect(t?.top).toBe(low.top + HUD_EDGE);
    expect(t?.left).toBe(HUD_EDGE);
    expect(t?.right).toBe(topRightInset("compact"));
    // Once the top region is taller than the minimap column, the card spans the width.
    const tall = { top: minimapBlockHeight("compact") + HUD_EDGE, bottom: 310 };
    expect(tipLayout("compact", tall, false, false)?.right).toBe(HUD_EDGE);
    expect(tipLayout("compact", low, false, true)).toBeNull();
    expect(tipLayout("short", { top: 0, bottom: 156 }, true, false)).toBeNull();
  });

  it("is hidden while any panel is open on every layout", () => {
    for (const layout of ["desktop", "compact", "short"] as const) {
      expect(tipLayout(layout, NO_INSETS, true, false)).toBeNull();
    }
  });
});
