/** Presence load-test building blocks (tools/e2e reuses them for the loadtest feature). */
export { PoseBot, SwarmSink, TAG_PREFIX, newGuest, type BotOptions, type Guest } from "./bot.ts";
export { BotPool, type GrowResult, type PoolReport } from "./pool.ts";
export { Histogram, percentilesOf, type HistogramData, type Percentiles } from "./stats.ts";
