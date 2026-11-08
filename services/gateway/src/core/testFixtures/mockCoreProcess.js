#!/usr/bin/env node
/**
 * TEST-ONLY mock "Core" process. Speaks exactly the protocol in
 * docs/CORE_PROTOCOL.md over its own stdin/stdout — a real, separate
 * OS process, not an in-process fake — so coreClient.test.ts can
 * genuinely exercise process spawning, NDJSON framing, and response-id
 * matching, standing in for the real `axora-core` binary until a Rust
 * toolchain can build it.
 *
 * Mode is passed as argv[2]:
 *   normal        - responds correctly and immediately (real policy logic)
 *   delay-<ms>     - waits <ms> before responding to policy.evaluate
 *   crash          - exits immediately after starting, before responding to anything
 *   garbage        - writes an invalid (non-JSON) line for every request received
 *   outoforder     - buffers the first two requests, responds to the 2nd one first
 *
 * Not shipped as part of the gateway; not imported by any production
 * code, only by coreClient.test.ts.
 */

const mode = (process.argv[2] ?? "normal") === "serve" ? "normal" : (process.argv[2] ?? "normal");
// "serve" is the arg a real axora-core binary receives per
// docs/CORE_PROTOCOL.md (CoreClient always passes ["serve"] unless
// overridden) — treated as equivalent to "normal" here so this mock can
// stand in for AXORA_CORE_BIN exactly as the gateway invokes it, not
// just when coreClient.test.ts spawns it directly with an explicit mode.

/** The same decision rules as policy.ts / policy.rs — kept independent (not imported) so this mock is a genuine second implementation to cross-check against, not just a passthrough. */
function evaluate(params) {
  const stepsOk = params.steps_taken < params.max_steps && params.current_delegation_depth <= params.max_delegation_depth;
  if (!stepsOk) {
    return { decision: "deny", reason: "run limit reached (max_steps or max_delegation_depth exceeded)" };
  }
  if (params.risk_level === "dangerous") {
    return { decision: "require_approval" };
  }
  if (params.approval_policy === "ask") return { decision: "require_approval" };
  if (params.approval_policy === "auto_low_risk") {
    return params.risk_level === "high" ? { decision: "require_approval" } : { decision: "allow" };
  }
  return { decision: "allow" }; // "never"
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
}

if (mode === "crash") {
  process.exit(1);
}

let buffer = "";
const bufferedRequests = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length === 0) continue;
    handleLine(line);
  }
});

function handleLine(line) {
  const req = JSON.parse(line);

  if (mode === "garbage") {
    process.stdout.write("this is not valid json\n");
    return;
  }

  if (req.method === "ping") {
    respond(req.id, { pong: true });
    return;
  }

  if (req.method === "policy.evaluate") {
    if (mode === "outoforder") {
      bufferedRequests.push(req);
      if (bufferedRequests.length === 2) {
        const [first, second] = bufferedRequests;
        respond(second.id, evaluate(second.params));
        respond(first.id, evaluate(first.params));
      }
      return;
    }

    if (mode.startsWith("delay-")) {
      const ms = parseInt(mode.slice("delay-".length), 10);
      setTimeout(() => respond(req.id, evaluate(req.params)), ms);
      return;
    }

    respond(req.id, evaluate(req.params));
    return;
  }

  process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: `unknown method: ${req.method}` }) + "\n");
}
