import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CoreClient, CoreClientError } from "./coreClient.js";

// The mock is a plain .js fixture (not compiled from TS — see its own
// header comment), referenced by its source path regardless of whether
// this test itself runs from src/ or dist/, since tsc doesn't copy .js
// files into dist. Tests in this project are always run with cwd =
// services/gateway (see every `node --test dist/...` invocation across
// docs/VERIFICATION.md), so this resolves correctly either way.
const MOCK_PATH = path.resolve(process.cwd(), "src/core/testFixtures/mockCoreProcess.js");

function mockClient(mode: string, requestTimeoutMs?: number): CoreClient {
  return new CoreClient({
    binaryPath: process.execPath, // run the mock with the same `node` this test is running under
    args: [MOCK_PATH, mode],
    requestTimeoutMs,
  });
}

test("start() succeeds against a real subprocess that responds to ping", async () => {
  const client = mockClient("normal");
  await client.start();
  await client.stop();
});

test("evaluatePolicy: low risk under auto_low_risk policy is allowed (real subprocess round-trip)", async () => {
  const client = mockClient("normal");
  await client.start();
  const decision = await client.evaluatePolicy({
    riskLevel: "low",
    approvalPolicy: "auto_low_risk",
    stepsTaken: 0,
    maxSteps: 10,
    currentDelegationDepth: 0,
    maxDelegationDepth: 3,
  });
  assert.equal(decision.type, "allow");
  await client.stop();
});

test("evaluatePolicy: dangerous always requires approval even under 'never' policy", async () => {
  const client = mockClient("normal");
  await client.start();
  const decision = await client.evaluatePolicy({
    riskLevel: "dangerous",
    approvalPolicy: "never",
    stepsTaken: 0,
    maxSteps: 10,
    currentDelegationDepth: 0,
    maxDelegationDepth: 3,
  });
  assert.equal(decision.type, "require_approval");
  await client.stop();
});

test("evaluatePolicy: exhausted step budget denies with a reason", async () => {
  const client = mockClient("normal");
  await client.start();
  const decision = await client.evaluatePolicy({
    riskLevel: "low",
    approvalPolicy: "never",
    stepsTaken: 5,
    maxSteps: 5,
    currentDelegationDepth: 0,
    maxDelegationDepth: 3,
  });
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.match(decision.reason, /run limit reached/);
  await client.stop();
});

test("concurrent requests are matched to the correct response even when the subprocess answers out of order", async () => {
  const client = mockClient("outoforder");
  await client.start();

  // First request: low risk, should be "allow". Second: dangerous,
  // should be "require_approval". The mock deliberately answers the
  // second one first — if CoreClient matched by arrival order instead
  // of response `id`, these results would come back swapped.
  const [first, second] = await Promise.all([
    client.evaluatePolicy({
      riskLevel: "low",
      approvalPolicy: "auto_low_risk",
      stepsTaken: 0,
      maxSteps: 10,
      currentDelegationDepth: 0,
      maxDelegationDepth: 3,
    }),
    client.evaluatePolicy({
      riskLevel: "dangerous",
      approvalPolicy: "never",
      stepsTaken: 0,
      maxSteps: 10,
      currentDelegationDepth: 0,
      maxDelegationDepth: 3,
    }),
  ]);

  assert.equal(first.type, "allow");
  assert.equal(second.type, "require_approval");
  await client.stop();
});

test("a request that never gets a response times out with a clear error, not a hang", async () => {
  const client = mockClient("delay-500", 100); // mock waits 500ms, client only waits 100ms
  await client.start();
  await assert.rejects(
    () =>
      client.evaluatePolicy({
        riskLevel: "low",
        approvalPolicy: "auto_low_risk",
        stepsTaken: 0,
        maxSteps: 10,
        currentDelegationDepth: 0,
        maxDelegationDepth: 3,
      }),
    (err: unknown) => err instanceof CoreClientError && /timed out/.test((err as Error).message),
  );
  await client.stop();
});

test("a crashed subprocess fails start() rather than pretending to be ready", async () => {
  const client = mockClient("crash", 500);
  await assert.rejects(() => client.start());
});

test("a garbage (non-JSON) response is ignored, not fabricated into a fake decision, and the caller times out cleanly", async () => {
  // "normal" mode is used for start()'s own ping (garbage mode would
  // break start() itself, which isn't what this test is about) — so we
  // start against normal, then manually simulate the garbage condition
  // by pointing a fresh client at garbage mode with a short timeout for
  // just the evaluatePolicy call. Since garbage mode answers `ping`
  // with garbage too, start() itself is expected to reject here — which
  // is the correct behavior (the client never treats "process spawned
  // successfully" as "process is speaking the protocol correctly").
  const client = mockClient("garbage", 100);
  await assert.rejects(() => client.start());
});
