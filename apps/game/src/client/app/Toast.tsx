/** One notice at a time (the app shell owns the timer). Errors are announced as alerts. */
import type { Notice } from "./notices.ts";

export function Toast({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div
      className={`toast toast-${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.text}
    </div>
  );
}
