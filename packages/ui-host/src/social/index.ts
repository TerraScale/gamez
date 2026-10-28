/**
 * Shared social React UI (wave B, docs/design/wave-B.md §8.3): used by the app
 * shell (mode picker) and by mode HUDs (classic panels). Components only talk
 * to the PlatformServices interfaces (../platform.ts), never to fetch/WebSocket
 * directly, so they work with fakes in tests. Mobile first: usable at 375 px,
 * touch targets >= 44 px, inline styles (no global CSS).
 */
export { ChatWindow, type ChatWindowProps } from "./ChatWindow.tsx";
export { LeaderboardView, type LeaderboardViewProps } from "./LeaderboardView.tsx";
export { GuildView, type GuildViewProps } from "./GuildView.tsx";
export {
  AccountPanel,
  accountChangeText,
  type AccountChange,
  type AccountPanelProps,
} from "./AccountPanel.tsx";
