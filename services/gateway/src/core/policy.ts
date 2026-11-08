/**
 * Policy engine (master spec sections 24, 28, 59, 60) — TypeScript
 * mirror of services/core/src/policy.rs. The Rust Core is the intended
 * long-term home for this (per the spec: "Rust for... policy engine"),
 * but it can't be compiled in this sandbox (no rustc) or called from the
 * gateway (no cross-process boundary exists yet — see README "Next
 * implementation steps"). Since real tool calls flow through the gateway
 * today, the enforcement logic needs to actually run *here*, now, not
 * just exist unverified in Rust. This file is deliberately
 * logic-identical to policy.rs — when Rust Core becomes reachable, this
 * TS copy is replaced by a call across that boundary, not rewritten.
 */

export type RiskLevel = "low" | "medium" | "high" | "dangerous";

export type ApprovalPolicy = "ask" | "auto_low_risk" | "never";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "require_approval" }
  | { type: "deny"; reason: string };

/**
 * The interface AgentRunner actually depends on — satisfied by both the
 * local PolicyEngine below and CorePolicyProvider (coreClient.ts), which
 * delegates the same decision to a real Core subprocess over
 * docs/CORE_PROTOCOL.md. This is the pluggability point that makes the
 * gateway <-> Core integration a real wiring change rather than just a
 * standalone, never-connected client.
 */
export interface PolicyProvider {
  evaluate(risk: RiskLevel, limits: RunLimits): PolicyDecision | Promise<PolicyDecision>;
}

export class RunLimits {
  maxSteps: number;
  stepsTaken: number = 0;
  maxDelegationDepth: number;
  currentDelegationDepth: number = 0;

  constructor(maxSteps: number, maxDelegationDepth: number) {
    this.maxSteps = maxSteps;
    this.maxDelegationDepth = maxDelegationDepth;
  }

  canTakeStep(): boolean {
    return this.stepsTaken < this.maxSteps && this.currentDelegationDepth <= this.maxDelegationDepth;
  }

  recordStep(): void {
    this.stepsTaken++;
  }
}

export class PolicyEngine implements PolicyProvider {
  constructor(private approvalPolicy: ApprovalPolicy) {}

  /**
   * Dangerous actions ALWAYS require approval regardless of configured
   * policy — cannot be overridden by a looser ApprovalPolicy (spec
   * section 24).
   */
  evaluate(risk: RiskLevel, limits: RunLimits): PolicyDecision {
    if (!limits.canTakeStep()) {
      return { type: "deny", reason: "run limit reached (max_steps or max_delegation_depth exceeded)" };
    }

    if (risk === "dangerous") {
      return { type: "require_approval" };
    }

    switch (this.approvalPolicy) {
      case "ask":
        return { type: "require_approval" };
      case "auto_low_risk":
        return risk === "high" ? { type: "require_approval" } : { type: "allow" };
      case "never":
        return { type: "allow" };
    }
  }
}
