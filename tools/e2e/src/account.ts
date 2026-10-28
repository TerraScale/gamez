/**
 * Wave B e2e: the shared account economy (wallet, dev grant, cosmetics equip,
 * persistence across a dev-server restart) and guild chat access (members get
 * a welcome, outsiders a 4403 close). docs/design/wave-B.md §3.4, §5, §6.
 * Added by the wave B integrator.
 */
import type { CosmeticsView, GuildInfo, WalletView } from "@gamez/protocol";
import { api, registerGuest } from "./accounts.ts";
import { ChatBot } from "./chat-client.ts";
import { loginGuest } from "./client.ts";
import type { E2eFeature } from "./features.ts";
import { check } from "./report.ts";

const SKU = "cosmetic.title.founder";

interface AccountState {
  token: string;
}

async function closeCode(bot: ChatBot, timeoutMs = 5000): Promise<number | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const ev = await Promise.race([bot.closed, timeout]);
  return ev ? ev.code : null;
}

export const accountFeature: E2eFeature = {
  name: "account",
  async run(ctx) {
    const suffix = Date.now().toString(36);
    const a = await registerGuest(ctx.url, await loginGuest(ctx.url), `Eco ${suffix.slice(-4)}`);

    // Wallet starts empty; the economy has no faucet in wave B.
    const wallet = await api<WalletView>(ctx.url, "/api/account/wallet", { token: a.token });
    check(
      wallet.status === 200 && wallet.body.balances.coin === 0 && wallet.body.balances.gem === 0,
      "account: a new wallet holds 0 coin and 0 gem",
    );
    const anon = await api<unknown>(ctx.url, "/api/account/wallet");
    check(anon.status === 401, "account: the wallet needs a session (401)");

    // Equipping a cosmetic that is not owned is refused.
    const early = await api<{ error?: { code: string } }>(ctx.url, "/api/account/cosmetics/equip", {
      token: a.token,
      body: { slot: "title", id: SKU },
    });
    check(
      early.status === 400 && early.body.error?.code === "not_owned",
      "account: equipping an unowned cosmetic -> not_owned",
    );

    // Dev grant (stub hosts only), then equip.
    const grant = await api<{ granted?: boolean }>(ctx.url, "/api/dev/grant", {
      token: a.token,
      body: { sku: SKU },
    });
    check(grant.status === 200 && grant.body.granted === true, "account: dev grant of a title");
    const equip = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics/equip", {
      token: a.token,
      body: { slot: "title", id: SKU },
    });
    check(
      equip.status === 200 && equip.body.equipped.title === SKU,
      "account: the granted title is equipped",
    );
    ctx.state.set("account", { token: a.token } satisfies AccountState);

    // Guild chat: a member gets the welcome, an outsider is closed with 4403.
    const created = await api<{ guild?: GuildInfo }>(ctx.url, "/api/guilds", {
      token: a.token,
      body: {
        name: `Eco ${suffix}`,
        tag: `E${String(Date.now() % 1000).padStart(3, "0")}`,
        open: true,
      },
    });
    const guildId = created.body.guild?.id;
    check(created.status === 201 && guildId !== undefined, "account: A creates a guild");
    if (!guildId) return;
    const member = new ChatBot(ctx.url, a.token, `guild:${guildId}`, "member");
    try {
      const welcome = await member.waitFor(
        "guild welcome",
        (m): m is Extract<typeof m, { t: "welcome" }> => m.t === "welcome",
      );
      check(welcome.t === "welcome", "account: a guild member joins guild chat");
    } finally {
      await member.close();
    }
    const outsider = new ChatBot(ctx.url, ctx.guestB.token, `guild:${guildId}`, "outsider");
    const code = await closeCode(outsider);
    check(code === 4403, `account: a non-member is refused guild chat (close ${code})`);

    // Clean up: the last member leaving disbands the guild.
    const left = await api<unknown>(ctx.url, "/api/guilds/leave", {
      token: a.token,
      method: "POST",
      body: {},
    });
    check(left.status === 200, "account: the founder leaves (guild disbands)");
  },

  async afterRestart(ctx) {
    const st = ctx.state.get("account") as AccountState | undefined;
    if (!st) return;
    const cos = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics", { token: st.token });
    check(
      cos.status === 200 && cos.body.owned.includes(SKU) && cos.body.equipped.title === SKU,
      "account after restart: the owned and equipped title persisted",
    );
  },
};
