/**
 * Capped pool for short-lived visuals (float texts, effects). Items are created
 * on demand up to `max`; after that the oldest active item is recycled. The
 * caller owns the lifetime: `spawn` hands out an item, `retire` returns it.
 * Pure: no Pixi, so it is unit-tested directly.
 */
export class Pool<T> {
  /** Items currently in use, oldest first. Read-only for callers. */
  readonly active: T[] = [];
  private readonly idle: T[] = [];
  private total = 0;

  constructor(
    private readonly create: () => T,
    private readonly reset: (item: T) => void,
    private readonly max: number,
  ) {}

  /** Total items ever created and still alive (active + idle). */
  get size(): number {
    return this.total;
  }

  spawn(): T {
    let item: T;
    const reused = this.idle.pop();
    if (reused !== undefined) {
      item = reused;
    } else if (this.total < this.max) {
      item = this.create();
      this.total++;
    } else {
      // Full: recycle the oldest live item.
      const oldest = this.active.shift() as T;
      this.reset(oldest);
      item = oldest;
    }
    this.active.push(item);
    return item;
  }

  /** Returns an active item to the idle list. Unknown items are ignored. */
  retire(item: T): void {
    const i = this.active.indexOf(item);
    if (i < 0) return;
    this.active.splice(i, 1);
    this.reset(item);
    this.idle.push(item);
  }

  /** Destroys every item (active and idle) and empties the pool. */
  drain(destroy: (item: T) => void): void {
    for (const item of this.active) destroy(item);
    for (const item of this.idle) destroy(item);
    this.active.length = 0;
    this.idle.length = 0;
    this.total = 0;
  }
}
