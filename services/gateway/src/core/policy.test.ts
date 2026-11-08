import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, RunLimits } from "./policy.js";

// Same three cases as services/core/src/policy.rs's #[cfg(test)] module,
// by design — this is meant to be behaviorally identical to the Rust
// version until a real cross-process boundary replaces this TS copy.

test("dangerous always requires approval even under 'never' policy", () => {
  const engine = new PolicyEngine("never");
  const limits = new RunLimits(10, 3);
  const decision = engine.evaluate("dangerous", limits);
  assert.equal(decision.type, "require_approval");
});

test("exhausted step budget denies regardless of risk", () => {
  const engine = new PolicyEngine("auto_low_risk");
  const limits = new RunLimits(2, 3);
  limits.recordStep();
  limits.recordStep();
  const decision = engine.evaluate("low", limits);
  assert.equal(decision.type, "deny");
});

test("low risk auto-allowed under auto_low_risk policy", () => {
  const engine = new PolicyEngine("auto_low_risk");
  const limits = new RunLimits(10, 3);
  const decision = engine.evaluate("low", limits);
  assert.equal(decision.type, "allow");
});

test("high risk requires approval under auto_low_risk policy", () => {
  const engine = new PolicyEngine("auto_low_risk");
  const limits = new RunLimits(10, 3);
  const decision = engine.evaluate("high", limits);
  assert.equal(decision.type, "require_approval");
});

test("'ask' policy requires approval for every risk level, including low", () => {
  const engine = new PolicyEngine("ask");
  const limits = new RunLimits(10, 3);
  assert.equal(engine.evaluate("low", limits).type, "require_approval");
  assert.equal(engine.evaluate("medium", limits).type, "require_approval");
});

test("delegation depth exceeding the limit denies further steps", () => {
  const engine = new PolicyEngine("never");
  const limits = new RunLimits(10, 2);
  limits.currentDelegationDepth = 3;
  const decision = engine.evaluate("low", limits);
  assert.equal(decision.type, "deny");
});
