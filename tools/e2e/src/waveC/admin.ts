/**
 * Wave C e2e: admin (docs/design/wave-C.md §11). OWNER: T-admin.
 *
 * A registered player gets 401/403 on the admin API; a dev admin (granted on the
 * local dev host) reads the economy telemetry shape; a flag switched off answers
 * GET /api/config and stops the market (503 "disabled"); every flag is restored
 * to on in a finally block, because later features need them.
 */
import { loginGuest } from "../client.ts";
import { api, registerGuest } from "../accounts.ts";
import { check, fail } from "../report.ts";
import type { E2eContext, E2eFeature } from "../features.ts";

const FLAGS = ["bank", "market", "trade", "shops", "arena", "pass", "store"] as const;

interface ConfigBody {
  flags: Record<string, boolean>;
  seasonId: string;
  serverTime: number;
}

interface EconomyBody {
  at: number;
  moneySupply: { coin: number; gem: number };
  accounts: number;
  flows: { day: string; faucets: Record<string, number>; sinks: Record<string, number> }[];
  priceIndex: unknown[];
  market: { active: number; sold24h: number; volume24h: number };
  shops: { leased: number; auction: number; grace: number };
  purchases: { paid24h: number; revenueMinor24h: Record<string, number> };
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function setFlags(
  url: string,
  token: string,
  flags: Record<string, boolean>,
): Promise<{ status: number; body: ConfigBody }> {
  return api<ConfigBody>(url, "/api/admin/flags", { token, method: "POST", body: { flags } });
}

function allOn(flags: Record<string, boolean> | undefined): boolean {
  return FLAGS.every((f) => flags?.[f] === true);
}

export const adminFeature: E2eFeature = {
  name: "admin",
  async run(ctx: E2eContext) {
    const url = ctx.url;

    // A registered player who is not on the admin list.
    const player = await registerGuest(url, await loginGuest(url), "Probe Player");
    const denied = await api<ApiErrorBody>(url, "/api/admin/economy", { token: player.token });
    check(
      denied.status === 401 || denied.status === 403,
      `non-admin GET /api/admin/economy refused (${denied.status})`,
    );
    const anon = await api<ApiErrorBody>(url, "/api/admin/economy");
    check(anon.status === 401, `anonymous GET /api/admin/economy is 401 (${anon.status})`);
    const deniedWrite = await setFlags(url, player.token, { market: false });
    check(deniedWrite.status === 403, `non-admin flag write is 403 (${deniedWrite.status})`);

    // GET /api/admin/me answers a player with 200 (no failed request in the dashboard).
    const meBefore = await api<{ admin: boolean; devHost: boolean }>(url, "/api/admin/me", {
      token: player.token,
    });
    check(
      meBefore.status === 200 && meBefore.body.admin === false && meBefore.body.devHost === true,
      `GET /api/admin/me says not an admin on a dev host (${meBefore.status} ${JSON.stringify(meBefore.body)})`,
    );

    // Dev admin: the local dev host grants the caller.
    const self = await api<{ ok: boolean; admin: string }>(url, "/api/dev/admin/self", {
      token: player.token,
      method: "POST",
    });
    check(
      self.status === 200 && self.body.admin === "dev",
      `POST /api/dev/admin/self grants the caller (${self.status})`,
    );

    const meAfter = await api<{ admin: boolean; via?: string }>(url, "/api/admin/me", {
      token: player.token,
    });
    check(
      meAfter.body.admin === true && meAfter.body.via === "dev",
      `GET /api/admin/me says dev admin after the grant (${JSON.stringify(meAfter.body)})`,
    );

    const initial = await api<ConfigBody>(url, "/api/config");
    check(
      initial.status === 200 && typeof initial.body.seasonId === "string",
      "GET /api/config is public and carries a season",
    );
    check(allOn(initial.body.flags), `every flag starts on ${JSON.stringify(initial.body.flags)}`);

    const econ = await api<EconomyBody>(url, "/api/admin/economy?days=7", { token: player.token });
    const b = econ.body;
    check(
      econ.status === 200 &&
        typeof b.moneySupply?.coin === "number" &&
        typeof b.moneySupply?.gem === "number" &&
        typeof b.accounts === "number" &&
        Array.isArray(b.flows) &&
        b.flows.length === 7 &&
        Array.isArray(b.priceIndex) &&
        typeof b.market?.active === "number" &&
        typeof b.shops?.leased === "number" &&
        typeof b.purchases?.paid24h === "number",
      `dev admin reads the economy telemetry shape (${econ.status})`,
    );

    const moderation = await api<{ accounts: unknown[] }>(url, "/api/admin/moderation", {
      token: player.token,
    });
    check(
      moderation.status === 200 && Array.isArray(moderation.body.accounts),
      `dev admin reads the moderation queue (${moderation.status})`,
    );

    // Kill switch: market off -> the market answers 503 "disabled", for everyone.
    try {
      const off = await setFlags(url, player.token, { market: false });
      check(off.status === 200 && off.body.flags?.market === false, "flag write market:false");
      const seen = await api<ConfigBody>(url, "/api/config");
      check(seen.body.flags?.market === false, "GET /api/config shows market off");
      const search = await api<ApiErrorBody>(url, "/api/market/search", { token: player.token });
      check(
        search.status === 503 && search.body.error?.code === "disabled",
        `market search answers 503 disabled while off (${search.status} ${search.body.error?.code ?? ""})`,
      );
    } catch (err) {
      fail(`admin flag round trip threw: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      const restored = await setFlags(
        url,
        player.token,
        Object.fromEntries(FLAGS.map((f) => [f, true])),
      );
      const after = await api<ConfigBody>(url, "/api/config");
      check(
        restored.status === 200 && allOn(after.body.flags),
        `every flag restored to on ${JSON.stringify(after.body.flags)}`,
      );
      if (!allOn(after.body.flags)) fail("flags left off: restore them before other features run");
    }
  },
};
