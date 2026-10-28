/**
 * The current account (GET /api/me through platform.auth.me). Reloads when the
 * session token changes or `refresh()` is called. Without a platform it stays null.
 */
import { useCallback, useEffect, useState } from "react";
import type { AccountView, PlatformServices } from "@gamez/ui-host";

export interface AccountState {
  account: AccountView | null;
  loading: boolean;
  refresh: () => void;
}

export function useAccount(platform: PlatformServices | undefined, token: string): AccountState {
  const [state, setState] = useState<{ account: AccountView | null; loading: boolean }>({
    account: null,
    loading: platform !== undefined,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!platform) {
      setState({ account: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    platform.auth.me().then(
      (r) => {
        if (live) setState({ account: r.ok ? r.value : null, loading: false });
      },
      () => {
        if (live) setState({ account: null, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [platform, token, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { account: state.account, loading: state.loading, refresh };
}
