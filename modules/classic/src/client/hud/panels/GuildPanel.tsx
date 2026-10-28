/**
 * Panel "guild" (wave B, docs/design/wave-B.md §8.4). OWNER: T-classic-hud.
 * Wraps the shared GuildView (@gamez/ui-host) with api.platform. The account comes from
 * auth.me(); the guild chat is embedded through api.platform.chat. Without api.platform the
 * panel shows an offline note.
 */
import { GuildView } from "@gamez/ui-host";
import { PanelFrame, useHudLayout, type SlotProps } from "../common.tsx";
import { C } from "../styles.ts";
import { useAccountView } from "./AccountPanel.tsx";

export function GuildPanel({ api }: SlotProps) {
  const platform = api.platform ?? null;
  const compact = useHudLayout(api) !== "desktop";
  const state = useAccountView(platform);
  let body;
  if (!platform) {
    body = <p style={{ color: C.muted, margin: 0 }}>Offline: guilds need the game server.</p>;
  } else if (!state.loaded) {
    body = <p style={{ color: C.muted, margin: 0 }}>Loading…</p>;
  } else if (state.account === null) {
    body = (
      <p role="alert" style={{ color: C.danger, margin: 0 }}>
        {state.error ?? "The account could not be loaded."}
      </p>
    );
  } else {
    body = (
      <GuildView
        guilds={platform.guilds}
        account={state.account}
        chat={platform.chat}
        compact={compact}
        onChanged={state.reload}
      />
    );
  }
  return (
    <PanelFrame api={api} id="guild" title="Guild" width={480}>
      {body}
    </PanelFrame>
  );
}
