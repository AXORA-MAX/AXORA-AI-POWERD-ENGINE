//! Agent runtime (master spec section 22-23). `AgentRunner` is the actual
//! step loop: for each requested tool call, it asks the policy engine
//! whether it's allowed, executes it only on `Allow`, and stops the run
//! the moment limits are exhausted or a step is denied. Approval-required
//! actions are surfaced to the caller rather than executed — this layer
//! never auto-approves anything the policy engine didn't explicitly clear.

use crate::policy::{PolicyDecision, PolicyEngine, RunLimits};
use crate::tools::ToolRegistry;

#[derive(Debug, Clone)]
pub struct StepRequest {
    pub tool_name: String,
    pub input: String,
}

#[derive(Debug)]
pub enum StepOutcome {
    Executed { tool_name: String, output: String },
    AwaitingApproval { tool_name: String },
    Denied { tool_name: String, reason: String },
    UnknownTool { tool_name: String },
}

pub struct AgentRunner<'a> {
    registry: &'a ToolRegistry,
    policy: &'a PolicyEngine,
    limits: RunLimits,
}

impl<'a> AgentRunner<'a> {
    pub fn new(registry: &'a ToolRegistry, policy: &'a PolicyEngine, limits: RunLimits) -> Self {
        Self { registry, policy, limits }
    }

    /// Run one step. Returns the outcome; the caller (or a future
    /// approval UI) decides what to do with `AwaitingApproval` — this
    /// function never executes a tool on that path itself.
    pub fn step(&mut self, request: &StepRequest) -> StepOutcome {
        let Some(tool) = self.registry.get(&request.tool_name) else {
            return StepOutcome::UnknownTool { tool_name: request.tool_name.clone() };
        };

        let decision = self.policy.evaluate(tool.schema().risk_level, &self.limits);
        match decision {
            PolicyDecision::Deny(reason) => {
                StepOutcome::Denied { tool_name: request.tool_name.clone(), reason }
            }
            PolicyDecision::RequireApproval => {
                StepOutcome::AwaitingApproval { tool_name: request.tool_name.clone() }
            }
            PolicyDecision::Allow => {
                self.limits.record_step();
                match tool.execute(&request.input) {
                    Ok(output) => StepOutcome::Executed { tool_name: request.tool_name.clone(), output },
                    Err(reason) => StepOutcome::Denied { tool_name: request.tool_name.clone(), reason },
                }
            }
        }
    }

    /// Run a whole plan (an ordered list of steps), stopping as soon as a
    /// step comes back Denied or the run limit is hit. Steps needing
    /// approval are recorded but execution halts there — no silently
    /// skipping ahead past an unapproved action.
    pub fn run_plan(&mut self, plan: &[StepRequest]) -> Vec<StepOutcome> {
        let mut outcomes = Vec::new();
        for request in plan {
            let outcome = self.step(request);
            let should_stop = matches!(
                outcome,
                StepOutcome::Denied { .. } | StepOutcome::AwaitingApproval { .. }
            );
            outcomes.push(outcome);
            if should_stop {
                break;
            }
        }
        outcomes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::ApprovalPolicy;
    use crate::tools::EchoTool;

    #[test]
    fn executes_low_risk_steps_under_auto_low_risk_policy() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(EchoTool));
        let policy = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
        let limits = RunLimits::new(5, 2);
        let mut runner = AgentRunner::new(&registry, &policy, limits);

        let outcome = runner.step(&StepRequest { tool_name: "echo".into(), input: "hi".into() });
        match outcome {
            StepOutcome::Executed { output, .. } => assert_eq!(output, "hi"),
            other => panic!("expected Executed, got {other:?}"),
        }
    }

    #[test]
    fn unknown_tool_is_reported_not_silently_ignored() {
        let registry = ToolRegistry::new();
        let policy = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
        let limits = RunLimits::new(5, 2);
        let mut runner = AgentRunner::new(&registry, &policy, limits);

        let outcome = runner.step(&StepRequest { tool_name: "nope".into(), input: "".into() });
        assert!(matches!(outcome, StepOutcome::UnknownTool { .. }));
    }

    #[test]
    fn run_plan_stops_at_the_step_limit_instead_of_looping_forever() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(EchoTool));
        let policy = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
        let limits = RunLimits::new(2, 2); // budget for only 2 steps
        let mut runner = AgentRunner::new(&registry, &policy, limits);

        let plan: Vec<StepRequest> = (0..5)
            .map(|i| StepRequest { tool_name: "echo".into(), input: format!("step {i}") })
            .collect();
        let outcomes = runner.run_plan(&plan);

        let executed = outcomes
            .iter()
            .filter(|o| matches!(o, StepOutcome::Executed { .. }))
            .count();
        assert_eq!(executed, 2, "must not execute more steps than the run's budget allows");
    }
}
