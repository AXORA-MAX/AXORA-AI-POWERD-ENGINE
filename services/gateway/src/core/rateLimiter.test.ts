import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rateLimiter.js";

/** A controllable fake clock so tests are deterministic and instant — no real setTimeout delays. */
function fakeClock(startMs: number = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("allows requests up to capacity, then rejects the next one", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: clock.now });

  assert.equal(limiter.tryConsume("client-a").allowed, true);
  assert.equal(limiter.tryConsume("client-a").allowed, true);
  assert.equal(limiter.tryConsume("client-a").allowed, true);
  const fourth = limiter.tryConsume("client-a");
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSeconds > 0);
});

test("refills over time and allows requests again after waiting", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now });

  assert.equal(limiter.tryConsume("client-b").allowed, true);
  assert.equal(limiter.tryConsume("client-b").allowed, true);
  assert.equal(limiter.tryConsume("client-b").allowed, false);

  clock.advance(1000); // 1 second = 1 token refilled at refillPerSecond: 1
  assert.equal(limiter.tryConsume("client-b").allowed, true);
  // Bucket should be empty again immediately after consuming that refilled token.
  assert.equal(limiter.tryConsume("client-b").allowed, false);
});

test("different keys have completely independent buckets", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now });

  assert.equal(limiter.tryConsume("client-c").allowed, true);
  assert.equal(limiter.tryConsume("client-c").allowed, false, "client-c's single token is used up");
  assert.equal(limiter.tryConsume("client-d").allowed, true, "client-d has its own separate bucket");
});

test("retryAfterSeconds reflects actual time needed to refill, not a constant", () => {
  const clock = fakeClock();
  const slowLimiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.1, now: clock.now }); // 1 token per 10s
  slowLimiter.tryConsume("x");
  const result = slowLimiter.tryConsume("x");
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 10);
});

test("never refills beyond capacity even after a very long idle period", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: clock.now });
  limiter.tryConsume("y"); // 4 tokens left
  clock.advance(1_000_000); // a huge amount of time
  // Should be capped at 5, not accumulate indefinitely — consume 5 and then the 6th must fail.
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.tryConsume("y").allowed, true, `token ${i + 1} of 5 should be allowed`);
  }
  assert.equal(limiter.tryConsume("y").allowed, false);
});

test("constructor rejects non-positive capacity or refill rate", () => {
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 }));
  assert.throws(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 }));
  assert.throws(() => new RateLimiter({ capacity: -1, refillPerSecond: 1 }));
});

test("evictIdle removes buckets idle at least the threshold, keeps recently-active ones", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now });

  limiter.tryConsume("old-client"); // lastRefillMs = 0
  clock.advance(60_000);
  limiter.tryConsume("recent-client"); // lastRefillMs = 60_000

  assert.equal(limiter.bucketCount, 2);
  // Threshold of 30s: "old-client" (idle 60s) is evicted, "recent-client" (idle 0s) survives.
  const evicted = limiter.evictIdle(30_000);
  assert.equal(evicted, 1);
  assert.equal(limiter.bucketCount, 1);
});

test("evictIdle(0) removes every bucket regardless of how recently it was touched", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now });
  limiter.tryConsume("a");
  limiter.tryConsume("b");
  assert.equal(limiter.evictIdle(0), 2);
  assert.equal(limiter.bucketCount, 0);
});

test("never over-grants under real concurrent load, same key", async () => {
  // Reproduces, at the unit level, exactly the kind of race
  // claimAction.test.ts proved safe in Milestone 7: many concurrent
  // callers racing a single shared piece of state. tryConsume has no
  // `await` anywhere in its body — it's a single synchronous
  // read-modify-write — so JS run-to-completion semantics make each
  // call atomic with respect to the others regardless of how many are
  // "in flight" at once. This test exercises that property against the
  // real (non-fake) clock and genuine async concurrency (via
  // Promise.all over functions that each do a microtask hop before
  // calling tryConsume, so they don't just trivially serialize by
  // construction) rather than assuming the single-threaded reasoning
  // holds without checking.
  const limiter = new RateLimiter({ capacity: 10, refillPerSecond: 0.0001 }); // refill negligible for this test's duration
  const attempts = 50;

  async function attempt(): Promise<boolean> {
    await new Promise((resolve) => setImmediate(resolve)); // force genuine interleaving opportunity
    return limiter.tryConsume("hot-key").allowed;
  }

  const results = await Promise.all(Array.from({ length: attempts }, () => attempt()));
  const allowedCount = results.filter(Boolean).length;

  // With negligible refill during this test, exactly `capacity` (10)
  // of the 50 concurrent attempts should have been allowed — not more
  // (which would mean the bucket was over-granted under concurrency)
  // and not fewer (which would mean tokens were lost/double-counted).
  assert.equal(allowedCount, 10, `expected exactly capacity (10) grants under concurrency, got ${allowedCount}`);
});

test("concurrent load on different keys never cross-contaminates buckets", async () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
  const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);

  async function attempt(key: string): Promise<boolean> {
    await new Promise((resolve) => setImmediate(resolve));
    return limiter.tryConsume(key).allowed;
  }

  // Each key attempted twice concurrently, interleaved across all keys
  // — a bug that leaked state between buckets would likely show up as
  // some key granting 0 or 2, not exactly 1 each.
  const results = await Promise.all(keys.flatMap((k) => [attempt(k), attempt(k)]));
  for (let i = 0; i < keys.length; i++) {
    const [first, second] = [results[i * 2], results[i * 2 + 1]];
    const grantedForThisKey = [first, second].filter(Boolean).length;
    assert.equal(grantedForThisKey, 1, `key-${i} should have exactly 1 of its 2 concurrent attempts granted`);
  }
});
