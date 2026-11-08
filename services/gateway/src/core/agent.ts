import type { PolicyProvider, RunLimits } from "./policy.js";
import type { ToolRegistry } from "./tools.js";

export interface StepRequest {
  toolName: string;
  input: string;
}

export type StepOutcome =
  | { type: "executed"; toolName: string; output: string }
  | { type: "awaiting_approval"; toolName: string }
  | { type: "denied"; toolName: string; reason: string }
  | { type: "unknown_tool"; toolName: string };

/**
 * The actual agent step loop (master spec sections 22-23), mirroring
 * services/core/src/agent.rs. Never executes a tool on the
 * `awaiting_approval` path itself — that decision belongs to whatever
 * surfaces the approval to the user.
 */
export class AgentRunner {
  constructor(
    private registry: ToolRegistry,
    private policy: PolicyProvider,
    private limits: RunLimits,
  ) {}

  async step(request: StepRequest): Promise<StepOutcome> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return { type: "unknown_tool", toolName: request.toolName };
    }

    const decision = await this.policy.evaluate(tool.schema().riskLevel, this.limits);
    switch (decision.type) {
      case "deny":
        return { type: "denied", toolName: request.toolName, reason: decision.reason };
      case "require_approval":
        return { type: "awaiting_approval", toolName: request.toolName };
      case "allow": {
        this.limits.recordStep();
        try {
          const output = await tool.execute(request.input);
          return { type: "executed", toolName: request.toolName, output };
        } catch (err) {
          return { type: "denied", toolName: request.toolName, reason: String(err) };
        }
      }
    }
  }

  /**
   * Run an ordered plan, stopping the instant a step is denied or needs
   * approval — no silently skipping ahead past an unapproved action.
   */
  async runPlan(plan: StepRequest[]): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = [];
    for (const request of plan) {
      const outcome = await this.step(request);
      outcomes.push(outcome);
      if (outcome.type === "denied" || outcome.type === "awaiting_approval") break;
    }
    return outcomes;
  }
}
