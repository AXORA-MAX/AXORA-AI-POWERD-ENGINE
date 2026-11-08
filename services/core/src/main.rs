//! AXORA Core — orchestration entry point.
//!
//! Two modes:
//!   `axora-core`         - runs the policy/tool/agent demo (default,
//!                           unchanged from earlier milestones)
//!   `axora-core serve`   - runs the stdio protocol server
//!                           (docs/CORE_PROTOCOL.md) that
//!                           services/gateway/src/core/coreClient.ts
//!                           talks to
//!
//! NOT compiled in the environment that generated this file: no rustc
//! toolchain was available in that sandbox. Every module has unit tests
//! (`cargo test`) — run them yourself before trusting this further than
//! "plausible, standard, dependency-free Rust that was carefully
//! reasoned through but never executed."

mod agent;
mod policy;
mod rpc;
mod tools;

use agent::{AgentRunner, StepOutcome, StepRequest};
use policy::{ApprovalPolicy, PolicyEngine, RiskLevel, RunLimits};
use std::env;
use tools::{EchoTool, Tool, ToolRegistry, ToolSchema};

/// A second demo tool, deliberately marked Dangerous, so main() can show
/// the approval boundary actually stopping a run — not just the happy
/// path. A real dangerous tool (e.g. "delete_repository") would live
/// wherever the connector/tool-execution layer ends up; this one just
/// proves the wiring.
struct DeleteEverythingTool;

impl Tool for DeleteEverythingTool {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "delete_everything".into(),
            description: "Irreversible destructive action — demo only, never actually deletes anything.".into(),
            risk_level: RiskLevel::Dangerous,
            requires_auth: true,
        }
    }

    fn execute(&self, _input: &str) -> Result<String, String> {
        // Deliberately unreachable in this demo: the policy engine must
        // stop this at RequireApproval before AgentRunner ever calls
        // execute(). If this ever prints, the approval boundary broke.
        Ok("!! THIS SHOULD NEVER EXECUTE WITHOUT APPROVAL !!".into())
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("serve") {
        if let Err(e) = rpc::serve() {
            eprintln!("axora-core: fatal I/O error in serve mode: {e}");
            std::process::exit(1);
        }
        return;
    }

    run_demo();
}

fn run_demo() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(EchoTool));
    registry.register(Box::new(DeleteEverythingTool));

    let policy = PolicyEngine::new(ApprovalPolicy::AutoLowRisk);
    let limits = RunLimits::new(5, 2);
    let mut runner = AgentRunner::new(&registry, &policy, limits);

    let plan = vec![
        StepRequest { tool_name: "echo".into(), input: "hello from AXORA Core".into() },
        StepRequest { tool_name: "delete_everything".into(), input: "prod-database".into() },
        // Never reached: the plan halts at the AwaitingApproval step above.
        StepRequest { tool_name: "echo".into(), input: "should not run".into() },
    ];

    println!("[axora-core] running a 3-step plan through the policy + tool + agent layers:\n");
    for outcome in runner.run_plan(&plan) {
        match outcome {
            StepOutcome::Executed { tool_name, output } => {
                println!("  EXECUTED   {tool_name} -> {output}");
            }
            StepOutcome::AwaitingApproval { tool_name } => {
                println!("  APPROVAL   {tool_name} -> halted, waiting on user approval (as required for Dangerous risk)");
            }
            StepOutcome::Denied { tool_name, reason } => {
                println!("  DENIED     {tool_name} -> {reason}");
            }
            StepOutcome::UnknownTool { tool_name } => {
                println!("  UNKNOWN    {tool_name} -> not registered");
            }
        }
    }
}
