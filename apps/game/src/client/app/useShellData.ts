/**
 * React wrappers over the shell pollers (./pollers.ts): the feature flags
 * (refreshed on focus) and the notices inbox (bell count, trade invite toasts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice as InboxNotice } from "@gamez/protocol";
import type { ConfigApi, VaultApi } from "@gamez/ui-host";
import { createFlagWatcher, createNoticePoller, type NoticePoller } from "./pollers.ts";
import type { FlagMap } from "./screens.ts";

/**
 * Feature flags from GET /api/config. null until the first answer, and after a
 * failure: every feature shows (flags fail open, wave C §9.2).
 */
export function useFeatureFlags(config: ConfigApi | undefined, token: string): FlagMap | null {
  const [flags, setFlags] = useState<FlagMap | null>(null);
  useEffect(() => {
    if (!config) {
      setFlags(null);
      return;
    }
    let live = true;
    const watcher = createFlagWatcher(config, (next) => {
      if (live) setFlags(next);
    });
    const onFocus = () => {
      void watcher.refresh();
    };
    void watcher.refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [config, token]);
  return flags;
}

export interface InboxHook {
  /** Unread notices (0 until the first read). */
  unread: number;
  /** Reads the inbox now (e.g. after the notices sheet closed). */
  refresh: () => void;
}

/**
 * The notices bell. Polls every 20 s while the page is visible, and reads at
 * once when it becomes visible again. `onFreshInvite` gets each unread trade
 * invite that is new since the previous read (never the first read's backlog).
 */
export function useNotices(
  vault: VaultApi | undefined,
  enabled: boolean,
  onFreshInvite: (notice: InboxNotice) => void,
): InboxHook {
  const [unread, setUnread] = useState(0);
  const pollerRef = useRef<NoticePoller | null>(null);
  // The latest callback without restarting the poller on every render.
  const freshRef = useRef(onFreshInvite);
  freshRef.current = onFreshInvite;

  useEffect(() => {
    if (!vault || !enabled) {
      setUnread(0);
      return;
    }
    const poller = createNoticePoller({
      vault,
      visible: () => document.visibilityState !== "hidden",
      onState: (s) => setUnread(s.unread),
      onFreshInvite: (n) => freshRef.current(n),
    });
    pollerRef.current = poller;
    const onVisible = () => {
      if (document.visibilityState === "visible") void poller.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [vault, enabled]);

  const refresh = useCallback(() => {
    void pollerRef.current?.refresh();
  }, []);
  return { unread, refresh };
}
