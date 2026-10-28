/**
 * Shared helper for the wave C platform SDK files.
 * newOpId(): idempotency key for a mutating call (protocol isOpId()); callers
 * reuse the same id when they retry the same call.
 */
export function newOpId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
