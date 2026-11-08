import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../store.js";

/**
 * This test reproduces, at the Store level, exactly the race
 * `handleActionDecision` used to have: two concurrent attempts to act on
 * the same `awaiting_approval` action, with a real async gap (simulating
 * `tool.execute()`) between claiming it and finishing the work. Before
 * `claimAction` existed, both attempts could pass a "is it still
 * awaiting_approval?" check before either had written a new status.
 *
 * Why this genuinely tests the race rather than assuming it away: two
 * calls to an async function with no `await` before its DB call run
 * their synchronous portions back-to-back within the same microtask
 * turn (JS run-to-completion semantics) — so whichever call's
 * `claimAction` reaches the database first commits its atomic UPDATE
 * before the other call's `claimAction` even starts. That ordering
 * guarantee is exactly what makes this safe, and this test asserts on
 * its actual observable effect (exactly one winner) rather than on the
 * implementation detail itself.
 */
async function attemptDecision(store: SqliteStore, actionId: string): Promise<"won" | "lost"> {
  const claimed = await store.claimAction(actionId);
  if (!claimed) return "lost";
  // Simulate the real async work (tool.execute()) that sits between
  // claiming and finalizing in server.ts — this is the actual race
  // window; without an atomic claim beforehand, both callers could get
  // here.
  await new Promise((resolve) => setImmediate(resolve));
  await store.updateAction(actionId, { resultStatus: "success", approved: true });
  return "won";
}

test("claimAction: exactly one of two concurrent decisions on the same action wins", async () => {
  const store = new SqliteStore(":memory:");
  const action = await store.logAction({
    action: "delete_everything",
    riskLevel: "dangerous",
    approved: null,
    resultStatus: "awaiting_approval",
    toolName: "delete_everything",
    toolInput: "prod-db",
  });

  const [r1, r2] = await Promise.all([
    attemptDecision(store, action.id),
    attemptDecision(store, action.id),
  ]);

  const outcomes = [r1, r2].sort();
  assert.deepEqual(outcomes, ["lost", "won"], "exactly one attempt should win the claim");

  const final = await store.getAction(action.id);
  assert.equal(final?.resultStatus, "success");
});

test("claimAction returns undefined for an action that isn't awaiting_approval", async () => {
  const store = new SqliteStore(":memory:");
  const action = await store.logAction({
    action: "echo",
    riskLevel: "low",
    approved: true,
    resultStatus: "success",
    toolName: "echo",
    toolInput: "hi",
  });

  const claimed = await store.claimAction(action.id);
  assert.equal(claimed, undefined);
});

test("claimAction returns undefined for an unknown action id", async () => {
  const store = new SqliteStore(":memory:");
  const claimed = await store.claimAction("does-not-exist");
  assert.equal(claimed, undefined);
});
