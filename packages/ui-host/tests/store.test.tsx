import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoreApi } from "../src/platform.ts";
import { balanceLine, StoreView } from "../src/play/StoreView.tsx";

function fakeApi(): StoreApi {
  return {
    catalog: () => new Promise(() => {}),
    checkout: async () => ({ ok: false, code: "unavailable", message: "not used" }),
    orders: () => new Promise(() => {}),
  };
}

describe("<StoreView>", () => {
  it("renders the loading state until the catalog answers", () => {
    const html = renderToStaticMarkup(
      <StoreView
        store={fakeApi()}
        account={{} as never}
        country="BR"
        onCheckout={() => {}}
        canBuy
      />,
    );
    expect(html).toContain("Loading the store");
    expect(html).toContain('aria-label="Store"');
  });

  it("is a labelled section that fits a 375 px phone (fluid width, no fixed widths)", () => {
    const html = renderToStaticMarkup(
      <StoreView store={fakeApi()} account={{} as never} onCheckout={() => {}} canBuy={false} />,
    );
    expect(html).toContain("width:100%");
    expect(html).not.toMatch(/width:\s*[6-9]\d\dpx/);
  });
});

describe("store balance", () => {
  it("formats the wallet line", () => {
    expect(balanceLine(null)).toBe("Balance: —");
    expect(balanceLine({ coin: 1200, gem: 100 })).toBe("Balance: 1,200 coin · 100 gems");
  });
});
