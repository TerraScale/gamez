/** Entry points to the leaderboards and guild screens (shown only when online). */
export interface SocialBarProps {
  guildTag: string | null;
  onLeaderboards: () => void;
  onGuild: () => void;
}

export function SocialBar({ guildTag, onLeaderboards, onGuild }: SocialBarProps) {
  return (
    <nav className="social-bar" aria-label="Social">
      <button type="button" className="social-button" onClick={onLeaderboards}>
        Leaderboards
      </button>
      <button type="button" className="social-button" onClick={onGuild}>
        {guildTag ? `Guild [${guildTag}]` : "Guild"}
      </button>
    </nav>
  );
}
