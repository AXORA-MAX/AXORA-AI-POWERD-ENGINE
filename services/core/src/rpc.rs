//! Implements docs/CORE_PROTOCOL.md's server side: reads NDJSON requests
//! from stdin, writes NDJSON responses to stdout. This is the half of
//! the gateway <-> Core integration boundary that lives in Rust; the
//! TypeScript client (services/gateway/src/core/coreClient.ts) is
//! genuinely tested against a mock process speaking this exact protocol
//! — this file has not been compiled (no rustc in the sandbox that wrote
//! it), so treat it as "written to spec, not yet proven" until you run
//! `cargo build` and point coreClient.ts at the real binary.
//!
//! Every response is written with an explicit flush after each line —
//! buffered stdout that never reaches the parent process is exactly the
//! kind of bug that made the TypeScript mock hang during its own test
//! development (see docs/VERIFICATION.md Milestone 10), so getting this
//! right here, even unverified, matters.

use crate::policy::{ApprovalPolicy, PolicyDecision, PolicyEngine, RiskLevel, RunLimits};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
struct RpcRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
struct PolicyEvaluateParams {
    risk_level: String,
    approval_policy: String,
    steps_taken: u32,
    max_steps: u32,
    current_delegation_depth: u32,
    max_delegation_depth: u32,
}

fn parse_risk_level(s: &str) -> Result<RiskLevel, String> {
    match s {
        "low" => Ok(RiskLevel::Low),
        "medium" => Ok(RiskLevel::Medium),
        "high" => Ok(RiskLevel::High),
        "dangerous" => Ok(RiskLevel::Dangerous),
        other => Err(format!("unknown risk_level: \"{other}\"")),
    }
}

fn parse_approval_policy(s: &str) -> Result<ApprovalPolicy, String> {
    match s {
        "ask" => Ok(ApprovalPolicy::Ask),
        "auto_low_risk" => Ok(ApprovalPolicy::AutoLowRisk),
        "never" => Ok(ApprovalPolicy::Never),
        other => Err(format!("unknown approval_policy: \"{other}\"")),
    }
}

fn decision_to_json(decision: PolicyDecision) -> Value {
    match decision {
        PolicyDecision::Allow => json!({ "decision": "allow" }),
        PolicyDecision::RequireApproval => json!({ "decision": "require_approval" }),
        PolicyDecision::Deny(reason) => json!({ "decision": "deny", "reason": reason }),
    }
}

fn handle_policy_evaluate(params: Value) -> Result<Value, String> {
    let parsed: PolicyEvaluateParams =
        serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))?;

    let risk = parse_risk_level(&parsed.risk_level)?;
    let approval_policy = parse_approval_policy(&parsed.approval_policy)?;

    let mut limits = RunLimits::new(parsed.max_steps, parsed.max_delegation_depth);
    limits.steps_taken = parsed.steps_taken;
    limits.current_delegation_depth = parsed.current_delegation_depth;

    let engine = PolicyEngine::new(approval_policy);
    Ok(decision_to_json(engine.evaluate(risk, &limits)))
}

fn dispatch(method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "pong": true })),
        "policy.evaluate" => handle_policy_evaluate(params),
        other => Err(format!("unknown method: \"{other}\"")),
    }
}

fn write_response(stdout: &mut impl Write, id: &str, outcome: Result<Value, String>) -> io::Result<()> {
    let response = match outcome {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    writeln!(stdout, "{response}")?;
    stdout.flush()
}

/// Runs the protocol loop until stdin closes (the parent process exiting
/// or explicitly closing the pipe). Each line is handled independently —
/// a malformed request line produces an error logged to stderr and is
/// otherwise skipped (no `id` to respond to), rather than crashing the
/// whole process and taking down every other in-flight request.
pub fn serve() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: RpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("axora-core: malformed request line, ignoring: {e}");
                continue;
            }
        };

        let outcome = dispatch(&request.method, request.params);
        write_response(&mut stdout, &request.id, outcome)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_ping_returns_pong() {
        let result = dispatch("ping", Value::Null).unwrap();
        assert_eq!(result, json!({ "pong": true }));
    }

    #[test]
    fn dispatch_unknown_method_is_an_error_not_a_panic() {
        let result = dispatch("does.not.exist", Value::Null);
        assert!(result.is_err());
    }

    #[test]
    fn policy_evaluate_matches_the_direct_policy_engine_call() {
        let params = json!({
            "risk_level": "dangerous",
            "approval_policy": "never",
            "steps_taken": 0,
            "max_steps": 10,
            "current_delegation_depth": 0,
            "max_delegation_depth": 3
        });
        let result = dispatch("policy.evaluate", params).unwrap();
        assert_eq!(result, json!({ "decision": "require_approval" }));
    }

    #[test]
    fn policy_evaluate_reports_deny_reason_through_the_protocol() {
        let params = json!({
            "risk_level": "low",
            "approval_policy": "never",
            "steps_taken": 5,
            "max_steps": 5,
            "current_delegation_depth": 0,
            "max_delegation_depth": 3
        });
        let result = dispatch("policy.evaluate", params).unwrap();
        assert_eq!(result["decision"], "deny");
        assert!(result["reason"].as_str().unwrap().contains("run limit reached"));
    }

    #[test]
    fn policy_evaluate_rejects_an_unrecognized_risk_level_cleanly() {
        let params = json!({
            "risk_level": "extremely_dangerous",
            "approval_policy": "never",
            "steps_taken": 0,
            "max_steps": 10,
            "current_delegation_depth": 0,
            "max_delegation_depth": 3
        });
        let result = dispatch("policy.evaluate", params);
        assert!(result.is_err());
    }
}
