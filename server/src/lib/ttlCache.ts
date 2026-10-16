/**
 * Tiny in-process TTL cache for read-heavy aggregate computations
 * (trending tags, explore summaries, lab reads, etc).
 *
 * Single-process only — restart clears all entries. For multi-process
 * scaling, swap the underlying Map for Redis.
 */
type Entry<V> = { value: V; expiresAt: number };

/** Above this many entries a `set` first drops every expired one. */
const SWEEP_AT = 256;

export class TTLCache<K, V> {
  private store = new Map<K, Entry<V>>();
  private inflight = new Map<K, Promise<V>>();
  /** Bumped by `clear`, so a load that started before it cannot repopulate. */
  private generation = 0;

  constructor(private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    // An entry is otherwise only dropped when its own key is read again, so a
    // cache keyed by something open-ended (a username) grew without bound.
    if (this.store.size >= SWEEP_AT) this.sweep();
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.generation += 1;
  }

  /** Number of live-or-expired entries held (test hook). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Read-through wrapper: returns the cached value if fresh, otherwise runs
   * `loader`, caches the result, and returns it. Single-flight: concurrent
   * callers with the same missing key share one `loader` run. A rejected load
   * is not cached and does not stick — the next caller runs `loader` again.
   */
  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const run = loader().then(
      (value) => {
        if (this.generation === generation) {
          this.set(key, value);
          this.inflight.delete(key);
        }
        return value;
      },
      (err: unknown) => {
        if (this.generation === generation) this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, run);
    return run;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.store) if (now > e.expiresAt) this.store.delete(k);
  }
}
