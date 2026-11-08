/**
 * Rate limiting (master spec section 43). A real token-bucket
 * implementation, not a stub: each key (e.g. client IP) gets a bucket
 * that holds up to `capacity` tokens, refilling at `refillPerSecond`
 * tokens/second, decoupled from wall-clock sleeps so it's
 * deterministically testable — see rateLimiter.test.ts, which uses an
 * injected fake clock instead of real delays.
 */

export interface RateLimiterOptions {
  /** Max tokens a bucket can hold — the size of a burst a key can spend all at once. */
  capacity: number;
  /** Tokens added back per second. */
  refillPerSecond: number;
  /** Clock injection point for deterministic tests; defaults to the real Date.now. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying — only meaningful when allowed is false. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private now: () => number;

  constructor(private options: RateLimiterOptions) {
    if (options.capacity <= 0 || options.refillPerSecond <= 0) {
      throw new Error("RateLimiter capacity and refillPerSecond must both be positive");
    }
    this.now = options.now ?? Date.now;
  }

  /** Attempt to consume one token for `key`. Creates a full bucket on first use (burst-friendly for a new client, not a cold start penalty). */
  tryConsume(key: string): RateLimitResult {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
      const refill = elapsedSeconds * this.options.refillPerSecond;
      bucket.tokens = Math.min(this.options.capacity, bucket.tokens + refill);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = Math.ceil(deficit / this.options.refillPerSecond);
    return { allowed: false, retryAfterSeconds };
  }

  /**
   * Housekeeping: drop buckets that have been idle for at least
   * `idleThresholdMs`, so memory doesn't grow unbounded with one-off
   * clients. Safe to call periodically.
   *
   * Idle time alone is the right criterion — NOT a stored "is this
   * bucket full?" check. `bucket.tokens` is only updated lazily, inside
   * `tryConsume`, so an idle bucket's stored token count is stale by
   * definition (nothing has touched it to trigger a refill
   * calculation) and would never read as "full" no matter how long it
   * sat idle. Checking idle time directly sidesteps that: a bucket idle
   * for longer than it would take to fully refill is behaviorally
   * equivalent to a full bucket anyway (removing it just means the next
   * request for that key creates a fresh full bucket, which is what a
   * real refill would have produced). An earlier version of this method
   * checked the stale `tokens` field and would have evicted almost
   * nothing in practice — caught while writing a test for this exact
   * method, before it ever ran against real idle buckets.
   */
  evictIdle(idleThresholdMs: number): number {
    const nowMs = this.now();
    let evicted = 0;
    for (const [key, bucket] of this.buckets) {
      const idleMs = nowMs - bucket.lastRefillMs;
      if (idleMs >= idleThresholdMs) {
        this.buckets.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
