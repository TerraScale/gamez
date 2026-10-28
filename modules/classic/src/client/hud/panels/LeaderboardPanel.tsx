/**
 * Panel "leaderboard" (wave B, docs/design/wave-B.md §8.4). OWNER: T-classic-hud.
 * Wraps the shared LeaderboardView (@gamez/ui-host) for mode "classic". The class filter comes
 * from the classic class registry (the HUD snapshot), with the three starting classes as a
 * fallback. Without api.platform the panel shows an offline note.
 */
import { useMemo } from "react";
import { LeaderboardView, type PlatformServices } from "@gamez/ui-host";
import type { HudSnapshot } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { PanelFrame, useHudLayout, type SlotProps } from "../common.tsx";
import { C } from "../styles.ts";

/** Used only when the HUD snapshot carries no classes (never in play). */
export const FALLBACK_CLASSES: readonly { id: string; name: string }[] = [
  { id: "classic.warrior", name: "Warrior" },
  { id: "classic.rogue", name: "Rogue" },
  { id: "classic.sorcerer", name: "Sorcerer" },
];

function sameClasses(a: HudSnapshot["classes"], b: HudSnapshot["classes"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.id === b[i]?.id && c.name === b[i]?.name);
}

export function LeaderboardPanel({ api }: SlotProps) {
  const platform: PlatformServices | null = api.platform ?? null;
  const compact = useHudLayout(api) !== "desktop";
  const snapshotClasses = useSelect(api.hud, (s) => s.classes, sameClasses);
  const classes = useMemo(
    () =>
      snapshotClasses.length > 0
        ? snapshotClasses.map((c) => ({ id: c.id, name: c.name }))
        : [...FALLBACK_CLASSES],
    [snapshotClasses],
  );
  const selfId = api.session?.accountId ?? null;
  return (
    <PanelFrame api={api} id="leaderboard" title="Leaderboards" width={480}>
      {platform ? (
        <LeaderboardView
          api={platform.leaderboards}
          mode="classic"
          classes={classes}
          selfId={selfId}
          compact={compact}
        />
      ) : (
        <p style={{ color: C.muted, margin: 0 }}>Offline: leaderboards need the game server.</p>
      )}
    </PanelFrame>
  );
}
