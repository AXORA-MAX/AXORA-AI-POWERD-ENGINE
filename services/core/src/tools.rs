//! Tool System (master spec section 24). A tool is anything an agent can
//! invoke — every tool declares its own risk level, which the policy
//! engine (policy.rs) uses to decide whether execution needs approval.

use crate::policy::RiskLevel;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub risk_level: RiskLevel,
    pub requires_auth: bool,
}

/// What a tool actually does. Kept synchronous and side-effect-free at
/// this layer on purpose — the policy/approval boundary sits in front of
/// this trait, not inside individual tool implementations, so no tool can
/// bypass it by doing its own thing before the engine has approved it.
pub trait Tool {
    fn schema(&self) -> ToolSchema;
    fn execute(&self, input: &str) -> Result<String, String>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new() }
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        let name = tool.schema().name.clone();
        self.tools.insert(name, tool);
    }

    pub fn get(&self, name: &str) -> Option<&Box<dyn Tool>> {
        self.tools.get(name)
    }

    pub fn list(&self) -> Vec<ToolSchema> {
        self.tools.values().map(|t| t.schema()).collect()
    }
}

// Standard Rust idiom (clippy::new_without_default): a type with a
// no-argument `new()` should also implement `Default`. Added during a
// manual audit pass (no rustc available in this sandbox to catch it via
// `cargo clippy` directly) — safe to add without a compiler because it's
// mechanically equivalent to `new()` with no behavior change, not a
// speculative fix for anything actually broken.
impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// A trivial, real (not mocked-out) low-risk tool used to exercise the
/// registry + policy engine together in main.rs and in tests, without
/// needing any external I/O this sandbox can't provide.
pub struct EchoTool;

impl Tool for EchoTool {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "echo".into(),
            description: "Returns its input unchanged. Used to exercise the tool loop.".into(),
            risk_level: RiskLevel::Low,
            requires_auth: false,
        }
    }

    fn execute(&self, input: &str) -> Result<String, String> {
        Ok(input.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trips_a_registered_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(EchoTool));

        let tool = registry.get("echo").expect("echo tool should be registered");
        assert_eq!(tool.execute("hello").unwrap(), "hello");
        assert_eq!(tool.schema().risk_level, RiskLevel::Low);
    }

    #[test]
    fn unregistered_tool_lookup_returns_none() {
        let registry = ToolRegistry::new();
        assert!(registry.get("does_not_exist").is_none());
    }

    #[test]
    fn default_produces_an_empty_registry_equivalent_to_new() {
        let registry: ToolRegistry = Default::default();
        assert!(registry.get("echo").is_none());
        assert_eq!(registry.list().len(), 0);
    }
}
