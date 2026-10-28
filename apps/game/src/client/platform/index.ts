/**
 * Client platform SDK (wave-B.md §8.1): HTTP + chat sockets behind the
 * PlatformServices interfaces of @gamez/ui-host.
 *
 * `session()` always returns the current session (it changes on login/logout,
 * see ../session.ts onSessionChange); every request sends its token as
 * `Authorization: Bearer`. The app shell re-creates the platform when the
 * session changes, so the chat sockets are reopened with the new token.
 *
 * `options` exists for tests: an injectable fetch, WebSocket and origin.
 */
import type { PlatformServices, Session } from "@gamez/ui-host";
import { createAccountApi } from "./account.ts";
import { createAuthApi } from "./auth.ts";
import { type ChatSocketCtor, createChatApi } from "./chat.ts";
import { createGuildApi } from "./guilds.ts";
import { createHttp, type FetchFn, defaultOrigin } from "./http.ts";
import { createLeaderboardApi } from "./leaderboards.ts";
// wave C (docs/design/wave-C.md §10.1): one file per API, owners in each header.
import { createArenaApi } from "./arena.ts";
import { createConfigApi } from "./config.ts";
import { createMarketApi } from "./market.ts";
import { createPassApi } from "./pass.ts";
import { createShopsApi } from "./shops.ts";
import { createStoreApi } from "./store.ts";
import { createTradeApi } from "./trade.ts";
import { createVaultApi } from "./vault.ts";

export interface PlatformOptions {
  /** Defaults to the global fetch. */
  fetch?: FetchFn;
  /** Defaults to the global WebSocket. */
  WebSocket?: ChatSocketCtor;
  /** http(s) origin of the server; defaults to the app's origin. */
  origin?: string;
}

export { createAccountApi } from "./account.ts";
export { createAuthApi, sessionFromAuth } from "./auth.ts";
export { createChatApi, CHAT_MAX_VIEW, CHAT_SEND_TIMEOUT_MS } from "./chat.ts";
export { createGuildApi } from "./guilds.ts";
export { createHttp, buildQuery, errorFromBody, wsUrl } from "./http.ts";
export { createLeaderboardApi } from "./leaderboards.ts";

export function createPlatform(
  session: () => Session,
  options: PlatformOptions = {},
): PlatformServices | undefined {
  const token = () => session().token;
  const http = createHttp({ token, fetch: options.fetch });
  const WebSocketCtor = options.WebSocket ?? (globalThis.WebSocket as unknown as ChatSocketCtor);
  return {
    auth: createAuthApi({ http, token }),
    leaderboards: createLeaderboardApi(http),
    chat: createChatApi({
      token,
      origin: options.origin ?? defaultOrigin(),
      WebSocket: WebSocketCtor,
    }),
    guilds: createGuildApi(http),
    account: createAccountApi(http),
    vault: createVaultApi(http),
    trade: createTradeApi(http),
    market: createMarketApi(http),
    shops: createShopsApi(http),
    arena: createArenaApi(http),
    pass: createPassApi(http),
    store: createStoreApi(http),
    config: createConfigApi(http),
  };
}
