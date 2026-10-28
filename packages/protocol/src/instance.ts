/**
 * Wire messages for instanced modes (test modes "duel" and "steps",
 * later dungeons and arenas): client <-> InstanceDO over /ws/instance.
 *
 * Phase 1 is server-authoritative with full snapshots after each action;
 * clients may predict by running the same kernel sim locally and reconcile
 * on `result`. Deltas come later if the bench says snapshots are too big.
 */
import type { GameEvent, SimSnapshot } from "@gamez/kernel";

export interface ModeInfo {
  id: string;
  name: string;
  description: string;
  world: string | null;
}

export type InstanceClientMessage =
  /** First message after connecting. `fresh` discards the current instance (new run / new battle). */
  | { t: "join"; token: string; mode: string; fresh?: boolean }
  | { t: "action"; seq: number; name: string; payload: unknown }
  | { t: "ping"; clientTime: number };

export type InstanceServerMessage =
  | {
      t: "state";
      instanceId: string;
      mode: string;
      contentHash: string;
      /** Highest client action seq already applied (for reconciling predictions). */
      lastSeq: number;
      snapshot: SimSnapshot;
    }
  | {
      t: "result";
      seq: number;
      ok: boolean;
      error?: { code: string; message: string };
      events: GameEvent[];
      /** Authoritative state after the action (also sent when ok=false). */
      snapshot: SimSnapshot;
    }
  | { t: "pong"; clientTime: number; serverTime: number }
  | { t: "error"; code: string; message: string };
