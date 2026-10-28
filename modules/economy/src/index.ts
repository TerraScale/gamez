/**
 * @gamez/economy (wave C, docs/design/wave-C.md): the platform economy's
 * RULES as pure, deterministic functions and data — fees and taxes (sinks),
 * market eligibility and shards, shop plot leases, arena rating, battle pass
 * seasons, store products and telemetry math. The DOs (apps/game/src/server)
 * apply them; nothing here does I/O or reads clocks (callers pass `now`).
 */
export * from "./fees.ts";
export * from "./market.ts";
export * from "./lease.ts";
export * from "./rating.ts";
export * from "./season.ts";
export * from "./products.ts";
export * from "./telemetry.ts";
