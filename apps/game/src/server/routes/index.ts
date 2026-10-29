/**
 * The Worker's routes, tried in order (wave-B.md §1). CONTRACT (architect):
 * each feature owns exactly one file and its path prefix; add routes there,
 * not here.
 *
 *   auth.ts          /api/guest, /api/me, /api/auth/*, /api/account/name   T-auth
 *   account.ts       /api/account/* (wallet, stash, cosmetics), /api/dev/*  T-economy
 *   leaderboards.ts  /api/leaderboards                                     T-leaderboards
 *   guilds.ts        /api/guilds*                                          T-guilds
 *   chat.ts          /ws/chat, /api/admin/*                                T-chat
 *   presence.ts      /ws (presence worlds)                                 T-presence
 *   /ws/instance     instance/route.ts                                     T-verify
 *
 * Wave C (docs/design/wave-C.md §1.2) — each file owns its prefix:
 *   vault.ts   /api/account/vault, /api/account/notices*, /api/dev/economy/grant  T-escrow (before account.ts)
 *   trade.ts   /api/trade*                                  T-escrow
 *   market.ts  /api/market/*                                T-market
 *   shops.ts   /api/shops*, /api/dev/shops/advance          T-shops
 *   arena.ts   /api/arena/*                                 T-arena
 *   pass.ts    /api/pass*                                   T-pass
 *   store.ts   /api/store*, /api/pay/*                      T-pay
 *   admin.ts   /api/config, /api/admin/{economy,flags,moderation*}  T-admin (before chat.ts)
 *
 * Admin dashboard (docs/design/admin-dashboard.md §7):
 *   admin-metrics.ts  /api/admin/{overview,players*,gameplay,economy/details,monetization,
 *                     social,tech,tunables}                      (before admin.ts)
 *   telemetry.ts      /api/telemetry                              T-telemetry
 *   dev-metrics.ts    /api/dev/admin/seed-metrics (dev hosts)     T-analytics-core
 */
import { accountRoutes } from "./account.ts";
import { adminRoutes } from "./admin.ts";
import { adminMetricsRoutes } from "./admin-metrics.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { devMetricsRoutes } from "./dev-metrics.ts";
import { arenaRoutes } from "./arena.ts";
import { marketRoutes } from "./market.ts";
import { passRoutes } from "./pass.ts";
import { shopRoutes } from "./shops.ts";
import { storeRoutes } from "./store.ts";
import { tradeRoutes } from "./trade.ts";
import { vaultRoutes } from "./vault.ts";
import { authRoutes } from "./auth.ts";
import { chatRoutes } from "./chat.ts";
import { guildRoutes } from "./guilds.ts";
import { leaderboardRoutes } from "./leaderboards.ts";
import { presenceRoutes } from "./presence.ts";
import type { RouteHandler } from "./types.ts";

export type { RouteContext, RouteHandler } from "./types.ts";

export const ROUTES: readonly RouteHandler[] = [
  authRoutes,
  vaultRoutes,
  accountRoutes,
  leaderboardRoutes,
  guildRoutes,
  telemetryRoutes,
  devMetricsRoutes,
  adminMetricsRoutes,
  adminRoutes,
  chatRoutes,
  presenceRoutes,
  tradeRoutes,
  marketRoutes,
  shopRoutes,
  arenaRoutes,
  passRoutes,
  storeRoutes,
];
