/**
 * A real, minimal background task queue (master spec section 31: "Task
 * Engine" — background tasks specifically). Not a fake setTimeout-based
 * "looks async" shim: tasks are genuinely queued and processed by a
 * worker loop independent of the request that enqueued them, with a
 * configurable concurrency limit so a burst of large-document uploads
 * can't starve the event loop or a downstream resource (e.g. the DB)
 * all at once.
 *
 * Scope: in-process, in-memory. A real distributed queue (spec sections
 * 31, 46: "Queue systems", "Event systems") needs infrastructure this
 * sandbox doesn't have (Redis, a message broker, ...) — this is the
 * correct starting abstraction, not a permanent stand-in pretending to
 * be that infrastructure.
 */

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  error?: string;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

type TaskFn = () => Promise<void>;

export class TaskQueue {
  private records = new Map<string, TaskRecord>();
  private pending: { id: string; fn: TaskFn }[] = [];
  private activeCount = 0;
  private nextId = 1;

  constructor(private concurrency: number = 2) {
    if (concurrency < 1) throw new Error("TaskQueue concurrency must be at least 1");
  }

  /** Enqueue a task, returning its id immediately — the task itself runs later, off the calling stack. */
  enqueue(fn: TaskFn): string {
    const id = `task_${this.nextId++}`;
    this.records.set(id, { id, status: "pending", enqueuedAt: Date.now() });
    this.pending.push({ id, fn });
    // Deferred via queueMicrotask rather than calling drain() directly:
    // without this, a task with no `await` before its first side effect
    // (e.g. `async () => { doSomething(); }`) would start executing
    // synchronously inside THIS call, before enqueue() even returns to
    // its caller — defeating the actual purpose of a background queue
    // (the caller, e.g. an HTTP handler, needs to be able to return a
    // "pending" response before any task work has run). Caught by
    // taskQueue.test.ts, not assumed.
    queueMicrotask(() => this.drain());
    return id;
  }

  getStatus(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  /** Pull work off the queue up to the concurrency limit. Safe to call repeatedly — no-ops when nothing to do or already at capacity. */
  private drain(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.runOne(item.id, item.fn);
    }
  }

  private runOne(id: string, fn: TaskFn): void {
    this.activeCount++;
    const record = this.records.get(id)!;
    record.status = "running";
    record.startedAt = Date.now();

    fn()
      .then(() => {
        record.status = "completed";
      })
      .catch((err) => {
        record.status = "failed";
        record.error = String(err);
      })
      .finally(() => {
        record.finishedAt = Date.now();
        this.activeCount--;
        this.drain();
      });
  }

  /** Test/shutdown helper: resolves once every currently pending or running task has settled. */
  async drained(): Promise<void> {
    while (this.activeCount > 0 || this.pending.length > 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
