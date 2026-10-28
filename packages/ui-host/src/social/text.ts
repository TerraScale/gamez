/**
 * Plain-words copy and pure rules for the social components: error code
 * mapping, client-side validation (the server stays authoritative), and small
 * formatters. Pure functions only, so they are unit-tested without React.
 */
import {
  CHAT_MAX_LEN,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type AuthProvider,
  type ChatErrorCode,
  type GuildRole,
  type LeaderboardBoard,
  type ProviderInfo,
  type ReportReason,
} from "@gamez/protocol";

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

export function authErrorText(code: string, fallback?: string): string {
  switch (code) {
    case "bad_request":
      return "Check the form and try again.";
    case "weak_password":
      return `Passwords need at least ${PASSWORD_MIN} characters.`;
    case "bad_email":
      return "Enter a valid email address.";
    case "bad_name":
      return `Display names are ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters.`;
    case "email_taken":
      return "That email already has an account. Sign in instead.";
    case "identity_taken":
      return "That login is already linked to another account.";
    case "bad_credentials":
      return "Email or password is wrong.";
    case "locked":
      return "Too many attempts. Wait a few minutes and try again.";
    case "provider_disabled":
      return "That sign-in method is not available right now.";
    case "oauth_failed":
      return "The sign-in was cancelled or failed. Try again.";
    case "unauthorized":
      return "Your session ended. Sign in again.";
    default:
      return fallback || "Something went wrong. Try again.";
  }
}

export function guildErrorText(code: string, fallback?: string): string {
  switch (code) {
    case "bad_request":
      return "Something in that request was wrong.";
    case "bad_name":
      return "Pick a name of 3 to 24 letters or numbers.";
    case "bad_tag":
      return "Tags are 2 to 5 letters or numbers.";
    case "name_taken":
      return "That guild name is already taken.";
    case "already_in_guild":
      return "You are already in a guild.";
    case "not_in_guild":
      return "You are not in a guild.";
    case "not_found":
      return "That guild no longer exists.";
    case "full":
      return "That guild is full.";
    case "closed":
      return "That guild is invite only.";
    case "forbidden":
      return "Only officers and leaders can do that.";
    case "guest_forbidden":
      return "Create an account to join a guild.";
    default:
      return fallback || "Something went wrong. Try again.";
  }
}

export function chatErrorText(
  code: string,
  opts: { mutedUntil?: number | null; message?: string } = {},
): string {
  switch (code as ChatErrorCode) {
    case "rate_limited":
      return "Slow down a little, then try again.";
    case "muted":
      return opts.mutedUntil
        ? `You are muted until ${formatClock(opts.mutedUntil)}.`
        : "You are muted for a while.";
    case "too_long":
      return `Messages can be up to ${CHAT_MAX_LEN} characters.`;
    case "empty":
      return "Type a message first.";
    case "duplicate":
      return "You just sent that. Try something new.";
    case "filtered":
      return "That message was blocked by the word filter.";
    case "forbidden":
      return "You cannot post in this channel.";
    case "bad_message":
    case "internal":
      return "Your message could not be sent.";
    default:
      return opts.message || "Your message could not be sent.";
  }
}

export function reportReasonText(reason: ReportReason): string {
  switch (reason) {
    case "spam":
      return "Spam";
    case "abuse":
      return "Abuse or harassment";
    case "cheating":
      return "Cheating or scams";
    case "other":
      return "Something else";
  }
}

export const REPORT_REASONS: readonly ReportReason[] = ["spam", "abuse", "cheating", "other"];

export function providerLabel(provider: AuthProvider): string {
  switch (provider) {
    case "email":
      return "Email";
    case "google":
      return "Google";
    case "discord":
      return "Discord";
    case "apple":
      return "Apple";
  }
}

/** "Continue with Google", with the dev stub and disabled states spelled out. */
export function providerButtonText(info: ProviderInfo): string {
  if (!info.enabled) return `${providerLabel(info.id)} sign-in is not set up here`;
  const base = `Continue with ${providerLabel(info.id)}`;
  return info.stub ? `${base} (dev stub)` : base;
}

export function roleLabel(role: GuildRole): string {
  switch (role) {
    case "leader":
      return "Leader";
    case "officer":
      return "Officer";
    case "member":
      return "Member";
  }
}

export const BOARD_TABS: readonly { id: LeaderboardBoard; label: string; value: string }[] = [
  { id: "level", label: "Level", value: "Hero level" },
  { id: "depth", label: "Deepest depth", value: "Depth" },
  { id: "rift", label: "Rift", value: "Rift score" },
];

// ---------------------------------------------------------------------------
// Client-side validation (mirrors the server rules, which stay authoritative)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return "Enter your email address.";
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) return "Enter a valid email address.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** Empty is allowed (the server keeps the default name). */
export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
    return `Use ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters.`;
  }
  return null;
}

/** Same slug rule as the server's guildSlug(): 3..24 characters once normalised. */
export function guildSlug(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length >= 3 && slug.length <= 24 ? slug : null;
}

export function validateGuildName(name: string): string | null {
  if (!guildSlug(name)) return "Pick a name of 3 to 24 letters or numbers.";
  return null;
}

export function validateGuildTag(tag: string): string | null {
  return /^[A-Z0-9]{2,5}$/.test(tag.trim().toUpperCase())
    ? null
    : "Tags are 2 to 5 letters or numbers.";
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local "HH:MM" clock. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Groups thousands with a space-free comma: 12345 -> "12,345". Locale independent. */
export function formatInt(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function memberCountText(count: number): string {
  return count === 1 ? "1 member" : `${formatInt(count)} members`;
}

/** True when the list is scrolled close enough to the bottom to keep following new messages. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 32,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

export function isMuted(mutedUntil: number | null | undefined, now: number): boolean {
  return mutedUntil != null && mutedUntil > now;
}

/** Whether a member may be kicked by a viewer (wave-B.md §6: leader kicks anyone but self, officer kicks members). */
export function canKick(viewer: GuildRole | null, target: GuildRole, same: boolean): boolean {
  if (same || viewer === null) return false;
  if (viewer === "leader") return target !== "leader";
  if (viewer === "officer") return target === "member";
  return false;
}

/** Narrow a free-form string to a known report reason. */
export function parseReportReason(value: string): ReportReason {
  return (REPORT_REASONS as readonly string[]).includes(value) ? (value as ReportReason) : "other";
}
