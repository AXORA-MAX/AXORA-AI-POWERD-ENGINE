# AXORA Core Protocol (gateway <-> `services/core` integration boundary)

This is the concrete answer to the gap flagged since Milestone 4:
`services/gateway`'s TypeScript policy engine and `services/core`'s Rust
one have been two disconnected implementations of the same design. This
document specifies the wire protocol that connects them; `coreClient.ts`
implements the gateway side of it, `services/core/src/rpc.rs` implements
the Core side.

## Transport

Newline-delimited JSON (NDJSON) over the stdin/stdout of a child
process. The gateway spawns the `axora-core` binary (built with `cargo
build --release` from `services/core`) in `serve` mode:

```
axora-core serve
```

Every request is exactly one line of JSON written to the child's stdin,
terminated with `\n`. Every response is exactly one line of JSON on the
child's stdout, also `\n`-terminated. Requests and responses are matched
by `id`, not by order — a real (or future) Core implementation is free
to respond out of order or to interleave responses from concurrent
requests, and the client must not assume otherwise. Anything the child
writes to stderr is diagnostic/log output, never protocol data.

## Request

```json
{"id": "<string, unique per in-flight request>", "method": "<string>", "params": { ... }}
```

## Response

Success:
```json
{"id": "<matching request id>", "ok": true, "result": { ... }}
```

Failure:
```json
{"id": "<matching request id>", "ok": false, "error": "<human-readable message>"}
```

## Methods

### `ping`

Health check. No params. Used by the client to confirm the child process
is alive and actually speaking this protocol (as opposed to, say, a
binary that exists but crashed on startup, or one that isn't `axora-core`
at all) before trusting it with real requests.

- params: `{}`
- result: `{"pong": true}`

### `policy.evaluate`

The actual integration point: delegates a single policy decision — the
same decision `PolicyEngine::evaluate` makes in both `policy.rs` and its
TypeScript mirror `core/policy.ts` — to the Core process instead of
deciding it locally.

- params:
  ```json
  {
    "risk_level": "low" | "medium" | "high" | "dangerous",
    "approval_policy": "ask" | "auto_low_risk" | "never",
    "steps_taken": <integer>,
    "max_steps": <integer>,
    "current_delegation_depth": <integer>,
    "max_delegation_depth": <integer>
  }
  ```
- result:
  ```json
  {
    "decision": "allow" | "require_approval" | "deny",
    "reason": "<string, present only when decision is \"deny\">"
  }
  ```

The decision logic itself must remain identical to `PolicyEngine::evaluate`
in both `policy.rs` and `core/policy.ts` — this protocol does not change
the rules (dangerous always requires approval, exhausted run limits
always deny, etc.), only which process makes the call.

## Client behavior contract (what `coreClient.ts` guarantees)

- Every request gets exactly one response or a rejection (timeout,
  process exit, malformed response line) — never silently hangs forever
  and never fabricates a response the child didn't actually send.
- Concurrent requests are matched correctly by `id` regardless of
  response order — this is specifically tested (`coreClient.test.ts`)
  against a mock child process that deliberately responds out of order.
- If the child process was never started, exits unexpectedly, or writes
  a line that isn't valid JSON for this protocol, the client surfaces a
  clear error rather than falling back to a fabricated decision — a
  broken Core connection must never silently be treated as "allow" or
  any other specific policy outcome.

## Honest status

The Rust side (`services/core/src/rpc.rs`) is written to this spec but,
like the rest of `services/core`, has never been compiled — no `rustc`
in the sandbox this was built in. The TypeScript side
(`coreClient.ts`) is genuinely tested against a real child process: a
small Node-based mock (`coreClient.test.ts`'s fixture) that speaks
exactly this protocol, standing in for `axora-core` until a real
toolchain can build it. See `docs/VERIFICATION.md` Milestone 10 for
exactly what that proves and what it doesn't.
