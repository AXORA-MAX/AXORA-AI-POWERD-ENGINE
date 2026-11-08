import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ApprovalPolicy, PolicyDecision, PolicyProvider, RiskLevel, RunLimits } from "./policy.js";

/**
 * Gateway-side client for docs/CORE_PROTOCOL.md — the integration
 * boundary between this TypeScript gateway and the Rust
 * `services/core` binary. See that doc for the wire format; this file
 * is the concrete implementation of the "client behavior contract"
 * section there.
 */

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CoreClientOptions {
  /** Path to the axora-core binary, or any executable speaking the protocol (e.g. a test mock). */
  binaryPath: string;
  /** Extra args passed to the binary — defaults to ["serve"] per the protocol doc. */
  args?: string[];
  /** Per-request timeout in ms before rejecting with a timeout error. */
  requestTimeoutMs?: number;
}

export class CoreClientError extends Error {}

/**
 * Speaks docs/CORE_PROTOCOL.md to a child process. Does not start the
 * process until `start()` is called, and never fabricates a response —
 * every failure mode (process not found, crashed, sent garbage, timed
 * out) surfaces as a rejected promise, never a silently-assumed decision.
 */
export class CoreClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private requestTimeoutMs: number;

  constructor(private options: CoreClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  }

  async start(): Promise<void> {
    if (this.child) return;

    const child = spawn(this.options.binaryPath, this.options.args ?? ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    child.on("error", (err) => {
      this.failAllPending(new CoreClientError(`Core process error: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.failAllPending(
        new CoreClientError(`Core process exited unexpectedly (code=${code}, signal=${signal})`),
      );
    });

    // Confirm the process is actually alive and speaking this protocol
    // — not just that spawn() didn't immediately throw — before
    // declaring start() successful. If this fails (crashed process,
    // garbage response, timeout), the spawned child must not be left
    // running: a failed start() that leaks a live subprocess is a real
    // resource leak, caught by this client's own test suite hanging
    // instead of completing — see coreClient.test.ts / VERIFICATION.md
    // Milestone 10 for how that was found.
    try {
      await this.request("ping", {});
    } catch (err) {
      this.forceKill();
      throw err;
    }
  }

  private forceKill(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.failAllPending(new CoreClientError("Core client stopped"));
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      // A malformed line doesn't crash the client or get treated as any
      // particular response — it's simply unattributable, so nothing
      // resolves/rejects from it. If it *was* meant to answer a pending
      // request, that request will correctly time out instead of
      // hanging forever or being fabricated a fake success.
      return;
    }

    const id = message?.id;
    if (typeof id !== "string") return;
    const pending = this.pending.get(id);
    if (!pending) return; // response to a request we're no longer tracking (e.g. already timed out)

    this.pending.delete(id);
    clearTimeout(pending.timeout);

    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      pending.reject(new CoreClientError(message.error ?? "Core returned ok:false with no error message"));
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new CoreClientError("Core client not started — call start() first"));
    }
    const id = randomUUID();
    const line = JSON.stringify({ id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreClientError(`Core request "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(line);
    });
  }

  /** The actual integration point — see docs/CORE_PROTOCOL.md's policy.evaluate method. */
  async evaluatePolicy(params: {
    riskLevel: RiskLevel;
    approvalPolicy: ApprovalPolicy;
    stepsTaken: number;
    maxSteps: number;
    currentDelegationDepth: number;
    maxDelegationDepth: number;
  }): Promise<PolicyDecision> {
    const result = (await this.request("policy.evaluate", {
      risk_level: params.riskLevel,
      approval_policy: params.approvalPolicy,
      steps_taken: params.stepsTaken,
      max_steps: params.maxSteps,
      current_delegation_depth: params.currentDelegationDepth,
      max_delegation_depth: params.maxDelegationDepth,
    })) as { decision: string; reason?: string };

    switch (result.decision) {
      case "allow":
        return { type: "allow" };
      case "require_approval":
        return { type: "require_approval" };
      case "deny":
        return { type: "deny", reason: result.reason ?? "denied by Core" };
      default:
        throw new CoreClientError(`Core returned an unrecognized decision: "${result.decision}"`);
    }
  }
}

/**
 * Bridges CoreClient to the PolicyProvider interface AgentRunner
 * actually depends on — this is what makes "delegate policy decisions
 * to the Core subprocess" a real, pluggable alternative to the local
 * PolicyEngine rather than a parallel, never-connected code path. See
 * server.ts for where this gets selected (AXORA_CORE_BIN env var).
 */
export class CorePolicyProvider implements PolicyProvider {
  constructor(private client: CoreClient, private approvalPolicy: ApprovalPolicy) {}

  async evaluate(risk: RiskLevel, limits: RunLimits): Promise<PolicyDecision> {
    return this.client.evaluatePolicy({
      riskLevel: risk,
      approvalPolicy: this.approvalPolicy,
      stepsTaken: limits.stepsTaken,
      maxSteps: limits.maxSteps,
      currentDelegationDepth: limits.currentDelegationDepth,
      maxDelegationDepth: limits.maxDelegationDepth,
    });
  }
}
