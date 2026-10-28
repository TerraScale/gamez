/**
 * The swarm's latency tag: each pose carries its send time in the cosmetic
 * tag, "lt-<epoch ms>". Client tags are not free text (ADR 0007 R11): the
 * server relays only "Lv <n> <class>" and exactly this shape, LATENCY_TAG_PATTERN
 * in apps/game/src/server/presence/pose.ts (`lt-` plus digits), so the two
 * must change together.
 */
export const TAG_PREFIX = "lt-";

/** The tag of a pose sent at `ms` (epoch ms). */
export function latencyTag(ms: number): string {
  return `${TAG_PREFIX}${ms}`;
}

/** The send time a latency tag carries, or null for any other tag. */
export function parseLatencyTag(tag: string | undefined): number | null {
  if (!tag?.startsWith(TAG_PREFIX)) return null;
  const sent = Number(tag.slice(TAG_PREFIX.length));
  return Number.isFinite(sent) ? sent : null;
}
