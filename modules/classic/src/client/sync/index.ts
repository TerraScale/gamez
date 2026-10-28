/**
 * Server sync of the classic client (wave-B.md §2.5-§2.7): ServerSync
 * (recorder, pending segments, resync, local cache, save import) and the
 * small rules index.ts uses to pick server or local mode.
 */
import type { SaveRecord, SaveStore } from "../persist.ts";
import type { ServerSync } from "./server-sync.ts";

export {
  BANK_TEXT,
  BANK_TIMEOUT_MS,
  BOOT_TIMEOUT_MS,
  DEFAULT_LIMITS,
  HIDDEN_RECONNECT_MS,
  newBankOpId,
  ServerSync,
  SYNC_ACTOR,
  SYNC_TEXT,
  type ServerSyncOptions,
  type SyncBoot,
  type SyncHost,
} from "./server-sync.ts";
export {
  chainIsValid,
  clearSyncCache,
  decodeSyncCache,
  MAX_CACHE_CHARS,
  readSyncCache,
  SYNC_CACHE_PREFIX,
  syncCacheKey,
  writeSyncCache,
  type PendingSegment,
  type SyncCacheRecord,
} from "./cache.ts";

/**
 * Server mode when the host can connect a verified instance and the run is
 * not a throwaway: no `?seed=` and no cheats (the QA gallery has its own view).
 */
export function wantsServer(opts: {
  canConnect: boolean;
  seed: number | null;
  cheats: boolean;
}): boolean {
  return opts.canConnect && opts.seed === null && !opts.cheats;
}

/**
 * The game's SaveStore in server mode: save() writes the account cache
 * through ServerSync.persist; nothing else is read or cleared (the legacy
 * local save stays untouched, the server owns the hero).
 */
export function serverSaveStore(sync: Pick<ServerSync, "persist">): SaveStore {
  return {
    load: () => null,
    loadCarryable: () => null,
    save: (record: SaveRecord) => sync.persist(record.snapshot, record.settings),
    clear: () => {},
  };
}
