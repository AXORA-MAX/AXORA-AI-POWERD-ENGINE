import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "./taskQueue.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("enqueue returns immediately; the task body runs later, off the caller's stack", () => {
  const queue = new TaskQueue(1);
  let ran = false;
  queue.enqueue(async () => {
    ran = true;
  });
  // If this were fake/synchronous, `ran` would already be true here.
  assert.equal(ran, false, "task must not run synchronously inside enqueue()");
});

test("a task transitions pending -> running -> completed", async () => {
  const queue = new TaskQueue(1);
  const id = queue.enqueue(async () => {
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(queue.getStatus(id)?.status, "pending");
  await queue.drained();
  assert.equal(queue.getStatus(id)?.status, "completed");
});

test("a throwing task is recorded as failed with its error, not silently swallowed", async () => {
  const queue = new TaskQueue(1);
  const id = queue.enqueue(async () => {
    throw new Error("boom");
  });
  await queue.drained();
  const record = queue.getStatus(id);
  assert.equal(record?.status, "failed");
  assert.match(record?.error ?? "", /boom/);
});

test("a failed task does not block subsequent tasks from running", async () => {
  const queue = new TaskQueue(1);
  queue.enqueue(async () => {
    throw new Error("first task fails");
  });
  const secondId = queue.enqueue(async () => {
    /* succeeds */
  });
  await queue.drained();
  assert.equal(queue.getStatus(secondId)?.status, "completed");
});

test("concurrency limit is actually enforced: never more than N tasks running at once", async () => {
  const concurrency = 2;
  const queue = new TaskQueue(concurrency);
  let currentlyRunning = 0;
  let maxObservedConcurrency = 0;
  const gates = Array.from({ length: 5 }, () => deferred());

  for (let i = 0; i < 5; i++) {
    queue.enqueue(async () => {
      currentlyRunning++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, currentlyRunning);
      await gates[i].promise; // held open until the test releases it
      currentlyRunning--;
    });
  }

  // Give the queue a tick to start as many tasks as its concurrency allows.
  await new Promise((r) => setImmediate(r));
  assert.equal(currentlyRunning, concurrency, "exactly `concurrency` tasks should be running, not all 5");

  // Release all gates and let everything finish.
  gates.forEach((g) => g.resolve(undefined));
  await queue.drained();

  assert.equal(maxObservedConcurrency, concurrency, "concurrency must never have exceeded the configured limit");
});

test("tasks beyond the concurrency limit still eventually run (queue drains fully)", async () => {
  const queue = new TaskQueue(2);
  const completedOrder: number[] = [];
  for (let i = 0; i < 6; i++) {
    queue.enqueue(async () => {
      completedOrder.push(i);
    });
  }
  await queue.drained();
  assert.equal(completedOrder.length, 6, "all 6 tasks must eventually complete, not just the first 2");
});

test("constructor rejects a concurrency of less than 1", () => {
  assert.throws(() => new TaskQueue(0));
});
