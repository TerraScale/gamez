/** Header chip: "Save your progress" for guests, the display name for registered accounts, "Offline" without a platform. */
import type { AccountView, Session } from "@gamez/ui-host";

export interface AccountChipProps {
  session: Session;
  /** Null while loading or without a platform. */
  account: AccountView | null;
  /** False when the host has no platform (offline). */
  online: boolean;
  onOpen: () => void;
}

export function isRegistered(session: Session, account: AccountView | null): boolean {
  return account ? account.kind === "registered" : session.kind === "registered";
}

export function AccountChip({ session, account, online, onOpen }: AccountChipProps) {
  if (!online) return <span className="chip chip-offline">Offline</span>;
  if (!isRegistered(session, account)) {
    return (
      <button type="button" className="chip chip-action" onClick={onOpen}>
        Save your progress
      </button>
    );
  }
  return (
    <button type="button" className="chip" onClick={onOpen} aria-label="Account">
      {account?.displayName ?? session.name}
    </button>
  );
}
