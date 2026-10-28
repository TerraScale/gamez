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
 */
import { accountRoutes } from "./account.ts";
import { authRoutes } from "./auth.ts";
import { chatRoutes } from "./chat.ts";
import { guildRoutes } from "./guilds.ts";
import { leaderboardRoutes } from "./leaderboards.ts";
import { presenceRoutes } from "./presence.ts";
import type { RouteHandler } from "./types.ts";

export type { RouteContext, RouteHandler } from "./types.ts";

export const ROUTES: readonly RouteHandler[] = [
  authRoutes,
  accountRoutes,
  leaderboardRoutes,
  guildRoutes,
  chatRoutes,
  presenceRoutes,
];
