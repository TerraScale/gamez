/** App shell: picker entries, feature gating and the sheet stack rules (wave-C.md §10.4). */
import { describe, expect, it } from "vite-plus/test";
import type { FeatureFlag, Notice as InboxNotice } from "@gamez/protocol";
import type { PlatformServices } from "@gamez/ui-host";
import {
  ARENA_MODE,
  TOWN_WORLD,
  entryItem,
  flagOn,
  itemTitle,
  noticeTarget,
  pushItem,
  screenFlag,
  visibleEntries,
  type FlagMap,
  type ShellItem,
} from "../../src/client/app/screens.ts";

/** A platform with every wave C API present (the methods are never called here). */
function fullPlatform(over: Partial<PlatformServices> = {}): PlatformServices {
  const api = {} as never;
  return {
    auth: api,
    leaderboards: api,
    chat: api,
    guilds: api,
    account: api,
    vault: api,
    trade: api,
    market: api,
    shops: api,
    arena: api,
    pass: api,
    store: api,
    config: api,
    ...over,
  };
}

const ALL_OFF: FlagMap = {
  bank: false,
  market: false,
  trade: false,
  shops: false,
  arena: false,
  pass: false,
  store: false,
};

describe("visibleEntries", () => {
  it("offline (no platform) shows no entries", () => {
    expect(visibleEntries(undefined, null)).toEqual([]);
  });

  it("a full platform with no config shows every entry in bar order", () => {
    expect(visibleEntries(fullPlatform(), null)).toEqual([
      "market",
      "vault",
      "trade",
      "shops",
      "arena",
      "pass",
      "store",
      "notices",
    ]);
  });

  it("an absent API hides its button (and the bell when there is no vault)", () => {
    const entries = visibleEntries(fullPlatform({ market: undefined, vault: undefined }), null);
    expect(entries).not.toContain("market");
    expect(entries).not.toContain("vault");
    expect(entries).not.toContain("notices");
    expect(entries).toContain("trade");
  });

  it("a flag that is off hides only its own entry", () => {
    const flags: FlagMap = {
      ...ALL_OFF,
      market: false,
      trade: true,
      arena: true,
      pass: true,
      store: true,
      shops: true,
    };
    const entries = visibleEntries(fullPlatform(), flags);
    expect(entries).not.toContain("market");
    expect(entries).toContain("trade");
    expect(entries).toContain("vault");
    expect(entries).toContain("notices");
  });

  it("the vault and the bell have no flag: they stay with every config", () => {
    expect(visibleEntries(fullPlatform(), ALL_OFF)).toEqual(["vault", "notices"]);
  });
});

describe("flagOn", () => {
  it("fails open: no config (null) and a flag not present both show the feature", () => {
    expect(flagOn(null, "market")).toBe(true);
    expect(flagOn({}, "market")).toBe(true);
    expect(flagOn({ market: false }, "market")).toBe(false);
    expect(flagOn({ market: false }, undefined)).toBe(true);
  });
});

describe("entryItem and screenFlag", () => {
  it("shops opens the town's plots, arena the classic ladder", () => {
    expect(entryItem("shops")).toEqual({ id: "plots", world: TOWN_WORLD });
    expect(entryItem("arena")).toEqual({ id: "arena", mode: ARENA_MODE });
    expect(entryItem("notices")).toEqual({ id: "notices" });
  });

  it("each economy sheet names its flag; shop uses the shops flag", () => {
    expect(screenFlag({ id: "market" })).toBe<FeatureFlag>("market");
    expect(screenFlag({ id: "shop", world: TOWN_WORLD, plotId: "p1" })).toBe("shops");
    expect(screenFlag({ id: "plots", world: TOWN_WORLD })).toBe("shops");
    expect(screenFlag({ id: "vault" })).toBeUndefined();
    expect(screenFlag({ id: "guild" })).toBeUndefined();
  });
});

describe("pushItem", () => {
  it("appends a new sheet", () => {
    const stack: ShellItem[] = [{ id: "plots", world: TOWN_WORLD }];
    expect(pushItem(stack, { id: "shop", world: TOWN_WORLD, plotId: "p2" })).toEqual([
      { id: "plots", world: TOWN_WORLD },
      { id: "shop", world: TOWN_WORLD, plotId: "p2" },
    ]);
  });

  it("a sheet already in the stack is replaced and the ones above it dropped", () => {
    const stack: ShellItem[] = [
      { id: "notices" },
      { id: "trade", tradeId: "t1" },
      { id: "market" },
    ];
    expect(pushItem(stack, { id: "trade", tradeId: "t2" })).toEqual([
      { id: "notices" },
      { id: "trade", tradeId: "t2" },
    ]);
  });

  it("does not mutate the stack it was given", () => {
    const stack: ShellItem[] = [{ id: "vault" }];
    pushItem(stack, { id: "store" });
    expect(stack).toEqual([{ id: "vault" }]);
  });
});

describe("itemTitle", () => {
  it("names every sheet in plain words", () => {
    expect(itemTitle({ id: "plots", world: TOWN_WORLD })).toBe("Shops");
    expect(itemTitle({ id: "pass" })).toBe("Battle Pass");
    expect(itemTitle({ id: "guild" })).toBe("Guild");
    expect(itemTitle({ id: "leaderboards" })).toBe("Leaderboards");
  });
});

describe("noticeTarget", () => {
  const base = { id: "n", at: 1, text: "", read: false };
  const notice = (
    kind: InboxNotice["kind"],
    data: InboxNotice["data"] = {},
  ): Pick<InboxNotice, "kind" | "data"> => ({
    ...base,
    kind,
    data,
  });

  it("a trade invite opens that trade", () => {
    expect(noticeTarget(notice("trade.invite", { tradeId: "tr-9" }))).toEqual({
      id: "trade",
      tradeId: "tr-9",
    });
  });

  it("a trade notice without an id opens the trade screen", () => {
    expect(noticeTarget(notice("trade.invite"))).toEqual({ id: "trade" });
  });

  it("market and shop notices open their screens, others nothing", () => {
    expect(noticeTarget(notice("market.sold"))).toEqual({ id: "market" });
    expect(noticeTarget(notice("shop.rent_due"))).toEqual({ id: "plots", world: TOWN_WORLD });
    expect(noticeTarget(notice("system"))).toBeNull();
  });
});
