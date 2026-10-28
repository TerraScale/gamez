import { describe, expect, it } from "vite-plus/test";
import {
  defaultShopName,
  fixtureTag,
  saleScope,
  validAppearance,
  validShopName,
  withoutUid,
} from "../../src/server/shops/validate.ts";
import { testItem } from "../support/fake-gateway.ts";

describe("shop name and look", () => {
  it("accepts 3-24 plain characters", () => {
    expect(validShopName("Axe Shop")).toBe(true);
    expect(validShopName("Bob's_Gear-1")).toBe(true);
    expect(validShopName("abc")).toBe(true);
    expect(validShopName("a".repeat(24))).toBe(true);
  });

  it("rejects short, long and markup names", () => {
    expect(validShopName("ab")).toBe(false);
    expect(validShopName("a".repeat(25))).toBe(false);
    expect(validShopName("<b>bold</b>")).toBe(false);
    expect(validShopName("tab\tname")).toBe(false);
    expect(validShopName("émoji")).toBe(false);
  });

  it("accepts only unit.hero looks", () => {
    expect(validAppearance("unit.hero")).toBe(true);
    expect(validAppearance("unit.hero.blue_2")).toBe(true);
    expect(validAppearance("unit.hero.Blue")).toBe(false);
    expect(validAppearance("unit.monster")).toBe(false);
    expect(validAppearance("../secret")).toBe(false);
    expect(validAppearance(`unit.hero.${"a".repeat(60)}`)).toBe(false);
  });

  it("names a new shop after its plot", () => {
    expect(defaultShopName("p3")).toBe("Shop P3");
    expect(validShopName(defaultShopName("p3"))).toBe(true);
  });
});

describe("fixture tag and sale scope", () => {
  it("shows the owner and the state, at most 40 characters", () => {
    expect(fixtureTag("Alice", true)).toBe("Alice · Open");
    expect(fixtureTag("Alice", false)).toBe("Alice · Closed");
    const long = fixtureTag("x".repeat(100), true);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith(" · Open")).toBe(true);
  });

  it("scopes a sale to universal items or the origin mode", () => {
    const item = { ...testItem("axe"), uid: "u1", origin: "classic" } as const;
    expect(saleScope({ universal: false, origin: "classic" })).toBe("classic");
    expect(saleScope({ universal: true, origin: "classic" })).toBe("universal");
    expect(saleScope({ universal: false, origin: "" })).toBe("universal");
    expect(item.origin).toBe("classic");
  });

  it("drops the uid when an item goes back into a vault", () => {
    const full = {
      ...testItem("axe"),
      uid: "u1",
      count: 1,
      origin: "classic",
      universal: false,
      tradable: true,
      data: null,
    } as never;
    const stripped = withoutUid(full);
    expect("uid" in stripped).toBe(false);
    expect(stripped).toMatchObject({ itemId: "test.weapon.axe", origin: "classic" });
  });
});
