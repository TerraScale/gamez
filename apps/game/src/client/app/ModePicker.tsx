import type { ModeInfo } from "@gamez/protocol";
import type { Session } from "@gamez/ui-host";

export interface ModePickerProps {
  session: Session;
  modes: readonly ModeInfo[];
  /** True when this client has a view for the mode. */
  isAvailable: (modeId: string) => boolean;
  onPick: (mode: ModeInfo) => void;
}

/** Full-width mode list with large touch targets; usable down to 375 px. */
export function ModePicker({ session, modes, isAvailable, onPick }: ModePickerProps) {
  return (
    <main className="picker">
      <header className="picker-header">
        <h1>gamez</h1>
        <p className="picker-who">Playing as {session.name}</p>
      </header>
      <h2 className="picker-title">Choose a mode</h2>
      <ul className="mode-list">
        {modes.map((mode) => {
          const available = isAvailable(mode.id);
          return (
            <li key={mode.id}>
              <button
                type="button"
                className="mode-card"
                disabled={!available}
                onClick={() => onPick(mode)}
              >
                <span className="mode-name">{mode.name}</span>
                <span className="mode-desc">{mode.description}</span>
                {available ? null : <span className="mode-badge">Not available yet</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
