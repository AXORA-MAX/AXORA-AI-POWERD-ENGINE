import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRunner } from "./agent.js";
import { PolicyEngine, RunLimits } from "./policy.js";
import { ToolRegistry, EchoTool, DeleteEverythingTool } from "./tools.js";

test("executes low-risk steps under auto_low_risk policy", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const runner = new AgentRunner(registry, new PolicyEngine("auto_low_risk"), new RunLimits(5, 2));

  const outcome = await runner.step({ toolName: "echo", input: "hi" });
  assert.equal(outcome.type, "executed");
  if (outcome.type === "executed") assert.equal(outcome.output, "hi");
});

test("unknown tool is reported, not silently ignored", async () => {
  const registry = new ToolRegistry();
  const runner = new AgentRunner(registry, new PolicyEngine("auto_low_risk"), new RunLimits(5, 2));

  const outcome = await runner.step({ toolName: "nope", input: "" });
  assert.equal(outcome.type, "unknown_tool");
});

test("a dangerous step halts the plan awaiting approval and never executes", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  registry.register(new DeleteEverythingTool());
  const runner = new AgentRunner(registry, new PolicyEngine("never"), new RunLimits(5, 2));

  const plan = [
    { toolName: "echo", input: "first" },
    { toolName: "delete_everything", input: "prod-db" },
    { toolName: "echo", input: "should not run" },
  ];
  const outcomes = await runner.runPlan(plan);

  assert.equal(outcomes.length, 2, "plan must halt at the approval boundary, not run the third step");
  assert.equal(outcomes[0].type, "executed");
  assert.equal(outcomes[1].type, "awaiting_approval");
});

test("run_plan stops at the step limit instead of looping forever", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const runner = new AgentRunner(registry, new PolicyEngine("auto_low_risk"), new RunLimits(2, 2));

  const plan = Array.from({ length: 5 }, (_, i) => ({ toolName: "echo", input: `step ${i}` }));
  const outcomes = await runner.runPlan(plan);

  const executed = outcomes.filter((o) => o.type === "executed").length;
  assert.equal(executed, 2, "must not execute more steps than the run's budget allows");
});
