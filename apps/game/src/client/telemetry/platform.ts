/**
 * Platform and device classification from coarse browser facts (docs/design/admin-dashboard.md §9).
 * OWNER: T-telemetry. Pure: the browser facts are passed in, nothing is stored.
 */
import type { ClientDevice, ClientPlatform } from "@gamez/protocol";

export interface PlatformFacts {
  userAgent: string;
  /** Running as an installed app (display-mode standalone or navigator.standalone). */
  standalone: boolean;
  /** navigator.maxTouchPoints. */
  touchPoints: number;
}

export interface PlatformInfo {
  platform: ClientPlatform;
  device: ClientDevice;
}

/** The platform/device enums sent with session.start. */
export function detectPlatform(facts: PlatformFacts): PlatformInfo {
  const ua = facts.userAgent;
  // iPadOS reports a desktop Mac user agent, so a touch-capable Mac is an iPad.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && facts.touchPoints > 1);
  const ios = /iPhone|iPod/.test(ua) || ipad;
  const android = /Android/.test(ua);

  let platform: ClientPlatform = "web";
  if (facts.standalone) platform = "pwa";
  else if (ios) platform = "ios";
  else if (android) platform = "android";

  let device: ClientDevice = "desktop";
  if (ipad || (android && !/Mobile/.test(ua)) || /Tablet|PlayBook|Silk/.test(ua)) device = "tablet";
  else if (/Mobi|iPhone|iPod/.test(ua) || (android && /Mobile/.test(ua))) device = "mobile";

  return { platform, device };
}
