/**
 * MetricsDO "local": the local/dev stand-in for Analytics Engine
 * (docs/design/admin-dashboard.md §4.3). OWNER: T-analytics-core.
 *
 * RPC surface: MetricsApi (contract) plus reset() for the dev seeder. The SQL
 * lives in analytics/local-store.ts (tested on FakeSqlStorage); this class
 * creates the schema in blockConcurrencyWhile and adapts RPC to the store.
 */
import { DurableObject } from "cloudflare:workers";
import { sqlStoreOf, type Env } from "../contracts.ts";
import { MetricsStore } from "../analytics/local-store.ts";
import type { MetricName, StoredPoint } from "../analytics/schema.ts";
import type {
  DistinctQuery,
  MetricsApi,
  QuantileQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "../analytics/types.ts";

export class MetricsDO extends DurableObject<Env> implements MetricsApi {
  #store: MetricsStore | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#store = new MetricsStore(sqlStoreOf(ctx.storage));
    });
  }

  get #db(): MetricsStore {
    // blockConcurrencyWhile runs before any RPC is delivered; this is a guard, not a path.
    this.#store ??= new MetricsStore(sqlStoreOf(this.ctx.storage));
    return this.#store;
  }

  async ingest(points: StoredPoint[]): Promise<void> {
    this.#db.ingest(points);
  }

  async totals(q: TotalsQuery<MetricName>): Promise<TotalsRow[]> {
    return this.#db.totals(q);
  }

  async series(q: SeriesQuery<MetricName>): Promise<SeriesRow[]> {
    return this.#db.series(q);
  }

  async quantiles(q: QuantileQuery<MetricName>): Promise<number[]> {
    return this.#db.quantiles(q);
  }

  async distinct(q: DistinctQuery<MetricName>): Promise<number> {
    return this.#db.distinct(q);
  }

  /** Not in MetricsApi: clears the stub (dev seeder). `seedOnly` keeps real dev points. */
  async reset(seedOnly = false): Promise<number> {
    return this.#db.reset(seedOnly);
  }
}
