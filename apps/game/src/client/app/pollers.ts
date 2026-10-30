/**
 * Background reads of the shell: the notices inbox (bell count, trade invite
 * toasts) and the feature flags (picker buttons). Plain controllers with no
 * React, so the timing is unit-tested with fake timers.
 */
import type { Notice as InboxNotice } from "@gamez/protocol";
import type { ConfigApi, VaultApi } from "@gamez/ui-host";
import type { FlagMap } from "./screens.ts";

/** Inbox poll interval while the page is visible (wave C §10.4). */
export const NOTICE_POLL_MS = 20_000;

/**
 * Notices that toast when they arrive (the rest only raise the bell count):
 * a trade invite waits on the player, rent due or a repossession costs them
 * their shop if missed, and a full vault holds their deliveries until they
 * free a slot (one notice per full spell).
 */
export const TOAST_NOTICE_KINDS: ReadonlySet<InboxNotice["kind"]> = new Set([
  "trade.invite",
  "shop.rent_due",
  "shop.repossessed",
  "vault.full",
]);

export interface InboxState {
  unread: number;
  notices: readonly InboxNotice[];
}

export interface NoticePollerOptions {
  vault: VaultApi;
  /** Defaults to NOTICE_POLL_MS. */
  intervalMs?: number;
  /** False while the page is hidden: the timer then skips its read. */
  visible?: () => boolean;
  onState(state: InboxState): void;
  /**
   * An unread toast-worthy notice (TOAST_NOTICE_KINDS: trade invites, rent
   * due, repossession) that was not in the previous read. The first read
   * only records what is there, so an old backlog never toasts on load.
   */
  onFreshInvite(notice: InboxNotice): void;
}

export interface NoticePoller {
  /** One read now. Concurrent calls share the request. A failed read keeps the last state. */
  refresh(): Promise<void>;
  /** Reads now, then every interval while visible. Idempotent. */
  start(): void;
  stop(): void;
}

export function createNoticePoller(opts: NoticePollerOptions): NoticePoller {
  const intervalMs = opts.intervalMs ?? NOTICE_POLL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let seen: Set<string> | null = null;
  let inflight: Promise<void> | null = null;

  const read = async (): Promise<void> => {
    try {
      const res = await opts.vault.notices();
      if (!res.ok) return;
      const list = res.value.notices;
      opts.onState({ unread: res.value.unread, notices: list });
      if (seen !== null) {
        for (const n of list) {
          if (!seen.has(n.id) && !n.read && TOAST_NOTICE_KINDS.has(n.kind)) opts.onFreshInvite(n);
        }
      }
      seen = new Set(list.map((n) => n.id));
    } catch {
      // Offline or a bad response: the bell keeps its last count.
    }
  };

  const refresh = (): Promise<void> => {
    if (inflight === null) {
      inflight = read().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  return {
    refresh,
    start() {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => {
        if (opts.visible === undefined || opts.visible()) void refresh();
      }, intervalMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

export interface FlagWatcher {
  /** Reads the flags. Any failure reports null: every feature shows (fail open). */
  refresh(): Promise<void>;
}

export function createFlagWatcher(
  config: ConfigApi,
  onFlags: (flags: FlagMap | null) => void,
): FlagWatcher {
  let inflight: Promise<void> | null = null;
  const read = async (): Promise<void> => {
    try {
      const res = await config.get();
      onFlags(res.ok ? res.value.flags : null);
    } catch {
      onFlags(null);
    }
  };
  return {
    refresh() {
      if (inflight === null) {
        inflight = read().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
