/**
 * Panel "account" (wave B, docs/design/wave-B.md §8.4). OWNER: T-classic-hud.
 * Wraps the shared AccountPanel (@gamez/ui-host) with api.platform: loads the account with
 * auth.me() and reloads it after any change. Without api.platform the panel shows an offline note.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AccountPanel as SharedAccountPanel,
  type AccountView,
  type PlatformServices,
} from "@gamez/ui-host";
import { Btn, PanelFrame, useHudLayout, type SlotProps } from "../common.tsx";
import { C } from "../styles.ts";

export interface AccountState {
  /** False until the first auth.me() answer. */
  loaded: boolean;
  account: AccountView | null;
  /** Player-facing message when the account could not be loaded. */
  error: string | null;
  reload: () => void;
}

/** The current account, loaded once and reloaded on session change or on reload(). */
export function useAccountView(platform: PlatformServices | null): AccountState {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<Omit<AccountState, "reload">>({
    loaded: false,
    account: null,
    error: null,
  });
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    if (!platform) return;
    let alive = true;
    platform.auth.me().then(
      (r) => {
        if (!alive) return;
        setState(
          r.ok
            ? { loaded: true, account: r.value, error: null }
            : { loaded: true, account: null, error: r.message },
        );
      },
      () => {
        if (alive) setState({ loaded: true, account: null, error: "Could not reach the server." });
      },
    );
    return () => {
      alive = false;
    };
  }, [platform, reloadKey]);
  useEffect(() => {
    if (!platform) return;
    return platform.auth.onSessionChange(reload);
  }, [platform, reload]);
  return { ...state, reload };
}

export function AccountPanel({ api }: SlotProps) {
  const platform = api.platform ?? null;
  const compact = useHudLayout(api) !== "desktop";
  const state = useAccountView(platform);
  let body;
  if (!platform) {
    body = <p style={{ color: C.muted, margin: 0 }}>Offline: accounts need the game server.</p>;
  } else if (!state.loaded) {
    body = <p style={{ color: C.muted, margin: 0 }}>Loading…</p>;
  } else if (state.account === null) {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p role="alert" style={{ color: C.danger, margin: 0 }}>
          {state.error ?? "The account could not be loaded."}
        </p>
        <Btn label="Try again" onClick={state.reload}>
          Try again
        </Btn>
      </div>
    );
  } else {
    body = (
      <SharedAccountPanel
        auth={platform.auth}
        account={state.account}
        onChanged={state.reload}
        compact={compact}
      />
    );
  }
  return (
    <PanelFrame api={api} id="account" title="Account" width={440}>
      {body}
    </PanelFrame>
  );
}
