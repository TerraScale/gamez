/**
 * Wave C e2e: payments: stub checkout -> stub complete -> gems credited once,
 * a signed webhook re-posted changes nothing, a bad signature is 401, the premium
 * pass and the cosmetic bundle are granted, cancel changes nothing, guests may
 * not buy (docs/design/wave-C.md §8, §13). OWNER: T-pay.
 *
 * The signed webhooks are built here with node:crypto and AUTH_SECRET from the
 * local apps/game/.dev.vars (git-ignored), so the test does not reuse the code
 * under test. Stub checkout only exists on dev hosts, which the e2e server is.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  CosmeticsView,
  OrdersResponse,
  PassView,
  StoreResponse,
  WalletView,
} from "@gamez/protocol";
import { api, registerGuest } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eFeature } from "../features.ts";
import { GAME_DIR } from "../paths.ts";
import { check } from "../report.ts";

interface CheckoutBody {
  orderId: string;
  url: string;
}

/** AUTH_SECRET from apps/game/.dev.vars, or "" when the file has none. */
function devAuthSecret(): string {
  try {
    const line = readFileSync(`${GAME_DIR}/.dev.vars`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("AUTH_SECRET="));
    return line ? line.slice("AUTH_SECRET=".length).trim() : "";
  } catch {
    return "";
  }
}

function signed(secret: string, raw: string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

/** Posts the form the sandbox page posts; returns the redirect target (no following). */
async function completeStub(
  url: string,
  orderId: string,
  account: string,
  result: "paid" | "cancel",
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(`${url}/api/pay/stub/complete`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ order: orderId, account, result }).toString(),
  });
  return { status: res.status, location: res.headers.get("location") };
}

async function gems(url: string, token: string): Promise<number> {
  const w = await api<WalletView>(url, "/api/account/wallet", { token });
  return w.body.balances.gem;
}

export const paymentsFeature: E2eFeature = {
  name: "payments",
  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const a = await registerGuest(ctx.url, guest, `Pay ${Date.now().toString(36).slice(-4)}`);
    const secret = devAuthSecret();

    // Catalog: public for guests too; the stub is on for this dev host.
    const catalog = await api<StoreResponse>(ctx.url, "/api/store?country=BR", { token: a.token });
    check(
      catalog.status === 200 && catalog.body.products.some((p) => p.sku === "gems.small"),
      "payments: GET /api/store lists the gem packs",
    );
    check(
      catalog.body.providers?.some((p) => p.id === "stub" && p.enabled),
      "payments: the sandbox stub is enabled on the dev host",
    );

    // A guest may look but not buy.
    // A fresh guest: the token of `guest` stopped working when it registered above.
    const freshGuest = await loginGuest(ctx.url);
    const guestBuy = await api<{ error?: { code: string } }>(ctx.url, "/api/store/checkout", {
      token: freshGuest.token,
      body: { opId: "e2e-guest-0001", sku: "gems.small", provider: "stub", currency: "USD" },
    });
    check(
      guestBuy.status === 403 && guestBuy.body.error?.code === "guest_forbidden",
      "payments: a guest cannot check out (403 guest_forbidden)",
    );

    // Gems: checkout, the sandbox page, complete.
    const opId = `e2e-pay-${Date.now().toString(36)}`;
    const checkout = await api<CheckoutBody>(ctx.url, "/api/store/checkout", {
      token: a.token,
      body: { opId, sku: "gems.small", provider: "stub", currency: "USD" },
    });
    check(
      checkout.status === 200 && /^o[0-9a-f]{24}$/.test(checkout.body.orderId ?? ""),
      "payments: checkout creates an order (200)",
    );
    const { orderId } = checkout.body;
    check(
      checkout.body.url?.includes("/api/pay/stub/checkout?order=") === true,
      "payments: checkout answers the stub page url",
    );

    const page = await fetch(`${ctx.url}${checkout.body.url.replace(ctx.url, "")}`);
    const html = await page.text();
    check(
      page.status === 200 && html.includes("Pay (sandbox)"),
      "payments: the sandbox page offers Pay (sandbox)",
    );

    const before = await gems(ctx.url, a.token);
    const paid = await completeStub(ctx.url, orderId, a.accountId, "paid");
    check(
      paid.status === 302 && paid.location === `/#store=paid&order=${orderId}`,
      "payments: complete redirects to /#store=paid&order=<id>",
    );
    check(
      (await gems(ctx.url, a.token)) === before + 100,
      "payments: the paid order credits 100 gems",
    );

    const orders = await api<OrdersResponse>(ctx.url, "/api/store/orders", { token: a.token });
    check(
      orders.body.orders?.some((o) => o.orderId === orderId && o.status === "paid") === true,
      "payments: the order is paid in /api/store/orders",
    );

    // The same signed webhook, posted again: verified, applied once.
    const raw = JSON.stringify({
      id: `stub_${orderId}_paid`,
      kind: "paid",
      orderId,
      accountId: a.accountId,
      providerRef: `stub_${orderId}`,
    });
    const hook = (sig: string) =>
      fetch(`${ctx.url}/api/pay/webhook/stub`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-stub-signature": sig },
        body: raw,
      });
    if (secret === "") {
      check(false, "payments: AUTH_SECRET found in apps/game/.dev.vars (needed to sign re-posts)");
    } else {
      const again = await hook(signed(secret, raw));
      check(again.status === 200, "payments: a signed re-post is answered 200");
      check(
        (await gems(ctx.url, a.token)) === before + 100,
        "payments: the re-post grants nothing twice",
      );
      const bad = await hook("0".repeat(64));
      check(bad.status === 401, "payments: a bad signature is 401");
      check(
        (await gems(ctx.url, a.token)) === before + 100,
        "payments: the bad signature changes nothing",
      );
    }

    // Cancel: the order stays pending and nothing is granted.
    const cancelOp = `e2e-cancel-${Date.now().toString(36)}`;
    const cancelOrder = await api<CheckoutBody>(ctx.url, "/api/store/checkout", {
      token: a.token,
      body: { opId: cancelOp, sku: "gems.small", provider: "stub", currency: "USD" },
    });
    const cancelled = await completeStub(ctx.url, cancelOrder.body.orderId, a.accountId, "cancel");
    check(cancelled.location === "/#store=cancel", "payments: cancel redirects to /#store=cancel");
    check(
      (await gems(ctx.url, a.token)) === before + 100,
      "payments: a cancelled order grants nothing",
    );

    // Premium pass: the entitlement unlocks the premium track.
    const pass = await api<CheckoutBody>(ctx.url, "/api/store/checkout", {
      token: a.token,
      body: {
        opId: `e2e-pass-${Date.now().toString(36)}`,
        sku: "pass.premium.2026-s1",
        provider: "stub",
        currency: "USD",
      },
    });
    check(pass.status === 200, "payments: checkout of the premium pass");
    const passPaid = await completeStub(ctx.url, pass.body.orderId, a.accountId, "paid");
    check(passPaid.status === 302, "payments: the premium pass completes");
    const passView = await api<PassView>(ctx.url, "/api/pass", { token: a.token });
    check(
      passView.status === 200 && passView.body.premium === true,
      `payments: the pass entitlement unlocks premium (GET /api/pass ${passView.status})`,
    );

    // Cosmetic bundle: its skus become owned.
    const bundle = await api<CheckoutBody>(ctx.url, "/api/store/checkout", {
      token: a.token,
      body: {
        opId: `e2e-bundle-${Date.now().toString(36)}`,
        sku: "bundle.ember",
        provider: "stub",
        currency: "USD",
      },
    });
    await completeStub(ctx.url, bundle.body.orderId, a.accountId, "paid");
    const cosmetics = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics", {
      token: a.token,
    });
    check(
      cosmetics.body.owned?.includes("cosmetic.title.ember") === true,
      "payments: the cosmetic bundle grants its skus",
    );
  },
};
