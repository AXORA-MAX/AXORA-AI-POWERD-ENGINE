//! Policy engine — the boundary every tool/agent action must pass through
//! before execution, per master spec sections 24, 28, 59, 60.
//!
//! This is real decision logic (not a stub that always returns true): it
//! enforces risk-based approval and per-run limits. Wiring it to an actual
//! tool executor and a UI approval flow is the next step once this compiles
//! against a real async runtime.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Dangerous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPolicy {
    /// Ask the user before every action regardless of risk.
    Ask,
    /// Auto-approve Low/Medium risk, still ask for High/Dangerous.
    AutoLowRisk,
    /// Never require interactive approval (still logged; use with care —
    /// the spec requires this to be an explicit, opt-in configuration).
    Never,
}

#[derive(Debug)]
pub enum PolicyDecision {
    Allow,
    RequireApproval,
    Deny(String),
}

pub struct RunLimits {
    pub max_steps: u32,
    pub steps_taken: u32,
    pub max_delegation_depth: u32,
    pub current_delegation_depth: u32,
}

impl RunLimits {
    pub fn new(max_steps: u32, max_delegation_depth: u32) -> Self {
        Self {
            max_steps,
            steps_taken: 0,
            max_delegation_depth,
            current_delegation_depth: 0,
        }
    }

    /// Called before every tool/agent step. Returns false when the run
    /// must stop — this is what prevents infinite loops and recursive
    /// delegation abuse (spec section 23).
    pub fn can_take_step(&self) -> bool {
        self.steps_taken < self.max_steps
            && self.current_delegation_depth <= self.max_delegation_depth
    }

    pub fn record_step(&mut self) {
        self.steps_taken += 1;
    }
}

pub struct PolicyEngine {
    pub approval_policy: ApprovalPolicy,
}

impl PolicyEngine {
    pub fn new(approval_policy: ApprovalPolicy) -> Self {
        Self { approval_policy }
    }

    /// Decide what must happen before a tool action with the given risk
    /// level executes. Dangerous actions ALWAYS require approval,
    /// regardless of configured policy — this cannot be overridden by a
    /// looser ApprovalPolicy, matching spec section 24 ("Dangerous/
    /// high-impact actions always require explicit user approval").
    pub fn evaluate(&self, risk: RiskLevel, limits: &RunLimits) -> PolicyDecision {
        if !limits.can_take_step() {
            return PolicyDecision::Deny(
                "run limit reached (max_steps or max_delegation_depth exceeded)".into(),
            );
        }

        if risk == RiskLevel::Dangerous {
            return PolicyDecision::RequireApproval;
        }

        match self.approval_policy {
            ApprovalPolicy::Ask => PolicyDecision::RequireApproval,
            ApprovalPolicy::AutoLowRisk => {
                if risk == RiskLevel::High {
                    PolicyDecision::RequireApproval
                } else {
                    PolicyDecision::Allow
                }
            }
            ApprovalPolicy::Never => PolicyDecision::Allow,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_always_requires_approval_even_under_never_policy() {
        let engine = PolicyEngine::new(ApprovalPolicy::Never);
        let limits = RunLimits::new(10, 3);
        let decision = engine.evaluate(RiskLevel::Dangerous, &limits);
        assert!(matches!(decision, PolicyDecision::RequireApproval));
    }

    #[test]
    fn exhausted_step_budget_denies_regardless_of_risk() {
        let engine = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
        let mut limits = RunLimits::new(2, 3);
        limits.record_step();
        limits.record_step();
        let decision = engine.evaluate(RiskLevel::Low, &limits);
        assert!(matches!(decision, PolicyDecision::Deny(_)));
    }

    #[test]
    fn low_risk_auto_allowed_under_auto_low_risk_policy() {
        let engine = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
        let limits = RunLimits::new(10, 3);
        let decision = engine.evaluate(RiskLevel::Low, &limits);
        assert!(matches!(decision, PolicyDecision::Allow));
    }
}
