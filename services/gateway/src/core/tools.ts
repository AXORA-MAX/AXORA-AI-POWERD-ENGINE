import type { RiskLevel } from "./policy.js";

export interface ToolSchema {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresAuth: boolean;
}

export interface Tool {
  schema(): ToolSchema;
  execute(input: string): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.schema().name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema());
  }
}

/** Low-risk tool used to exercise the registry/runner without any real I/O. */
export class EchoTool implements Tool {
  schema(): ToolSchema {
    return {
      name: "echo",
      description: "Returns its input unchanged. Used to exercise the tool loop.",
      riskLevel: "low",
      requiresAuth: false,
    };
  }
  async execute(input: string): Promise<string> {
    return input;
  }
}

/** Medium-risk tool: reads the server's current time. Real, not mocked — actual I/O, just harmless. */
export class GetCurrentTimeTool implements Tool {
  schema(): ToolSchema {
    return {
      name: "get_current_time",
      description: "Returns the gateway server's current UTC time.",
      riskLevel: "low",
      requiresAuth: false,
    };
  }
  async execute(): Promise<string> {
    return new Date().toISOString();
  }
}

/**
 * Dangerous demo tool, deliberately never actually destructive — proves
 * the approval boundary halts execution rather than performing the
 * action. A real dangerous tool (e.g. "delete_project") lives wherever
 * the connector layer ends up; this is wiring proof, not a real action.
 */
export class DeleteEverythingTool implements Tool {
  schema(): ToolSchema {
    return {
      name: "delete_everything",
      description: "Irreversible destructive action — demo only, never actually deletes anything.",
      riskLevel: "dangerous",
      requiresAuth: true,
    };
  }
  async execute(): Promise<string> {
    // Unreachable unless the approval boundary is broken — see agent.test.ts.
    return "!! THIS SHOULD NEVER EXECUTE WITHOUT APPROVAL !!";
  }
}
