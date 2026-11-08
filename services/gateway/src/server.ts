import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ModelRouter } from "./router.js";
import { MockProvider } from "./providers/mockProvider.js";
import type { ModelProvider } from "./providers/provider.js";
import { SqliteStore, type Store } from "./store.js";
import { retrieveMemories } from "./memory/retrieval.js";
import { retrieveChunks } from "./knowledge/retrieval.js";
import { getParser, supportedSourceTypes } from "./knowledge/parsers/registry.js";
import { PolicyEngine, RunLimits } from "./core/policy.js";
import type { ApprovalPolicy, PolicyProvider } from "./core/policy.js";
import { ToolRegistry, EchoTool, GetCurrentTimeTool, DeleteEverythingTool } from "./core/tools.js";
import { AgentRunner } from "./core/agent.js";
import { CoreClient, CorePolicyProvider } from "./core/coreClient.js";
import { TaskQueue } from "./core/taskQueue.js";
import { RateLimiter } from "./core/rateLimiter.js";
import { SecretVault } from "./core/secretVault.js";
import { logger } from "./logger.js";
import type {
  AgentRunInput,
  ChatCompletionRequest,
  ChatMessage,
  KnowledgeDocumentInput,
  MemoryInput,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.AXORA_SQLITE_PATH ?? ":memory:";
const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Store selection. PostgresStore is only ever reached when DATABASE_URL
 * is explicitly set — otherwise this stays on the verified SQLite dev
 * store. If DATABASE_URL IS set but the store can't actually be built
 * (missing `pg` package, unreachable server), this throws and refuses to
 * start rather than silently falling back — per "no fake capabilities",
 * a gateway that claims Postgres but is quietly running SQLite would be
 * exactly the kind of fabrication the spec prohibits.
 */
async function createStore(): Promise<{ store: Store; kind: string }> {
  if (DATABASE_URL) {
    const { PostgresStore } = await import("./postgresStore.js");
    const store = new PostgresStore(DATABASE_URL);
    logger.info("store_selected", { kind: "postgres" });
    return { store, kind: "postgres" };
  }
  const store = new SqliteStore(DB_PATH);
  logger.info("store_selected", { kind: "sqlite", path: DB_PATH });
  return { store, kind: "sqlite" };
}

/**
 * Provider registration. The mock provider is always available so the
 * gateway never fails to start. AnthropicProvider is loaded lazily via
 * dynamic import purely so a broken/missing module there can't take the
 * whole gateway down — a real failure is logged, not hidden.
 */
async function createProviders(): Promise<ModelProvider[]> {
  const providers: ModelProvider[] = [new MockProvider()];

  if (ANTHROPIC_API_KEY) {
    try {
      const { AnthropicProvider } = await import("./providers/anthropicProvider.js");
      providers.push(new AnthropicProvider({ apiKey: ANTHROPIC_API_KEY }));
      logger.info("provider_registered", { id: "anthropic" });
    } catch (err) {
      logger.error("anthropic_provider_registration_failed", { error: String(err) });
    }
  } else {
    logger.info("anthropic_provider_skipped", { reason: "ANTHROPIC_API_KEY not set" });
  }

  return providers;
}

let store: Store;
// Set in main() only when AXORA_SECRET_KEY is configured. Vault
// endpoints check for this explicitly and return a clear error when
// it's undefined, rather than the gateway crashing at startup over a
// feature nothing may be using, or silently no-op'ing if it is.
let secretVault: SecretVault | undefined;
let router: ModelRouter;

// Tool System + Policy Engine (master spec 22-28) — see core/*.ts.
const toolRegistry = new ToolRegistry();
toolRegistry.register(new EchoTool());
toolRegistry.register(new GetCurrentTimeTool());
toolRegistry.register(new DeleteEverythingTool());
const AGENT_APPROVAL_POLICY: ApprovalPolicy = "auto_low_risk";
const localPolicyEngine = new PolicyEngine(AGENT_APPROVAL_POLICY);

// Selected at startup by selectPolicyProvider(): the local PolicyEngine
// by default, or a CorePolicyProvider delegating to a real Core
// subprocess when AXORA_CORE_BIN is configured and actually starts
// successfully. This is the live selection point for the gateway <->
// Core integration boundary (docs/CORE_PROTOCOL.md) — not a standalone,
// never-connected client.
let activePolicyProvider: PolicyProvider = localPolicyEngine;

async function selectPolicyProvider(): Promise<void> {
  const corePath = process.env.AXORA_CORE_BIN;
  if (!corePath) {
    logger.info("policy_provider_selected", { provider: "local_typescript" });
    return;
  }

  const client = new CoreClient({ binaryPath: corePath, args: ["serve"] });
  try {
    await client.start();
    activePolicyProvider = new CorePolicyProvider(client, AGENT_APPROVAL_POLICY);
    logger.info("policy_provider_selected", { provider: "core_subprocess", binary: corePath });
  } catch (err) {
    // Per "no fake capabilities": a Core process that's configured but
    // unreachable/broken must not be silently treated as present. Fall
    // back to the local provider (still real, still enforcing policy
    // correctly — just not delegating) and say so loudly, rather than
    // either crashing the gateway or pretending Core is active.
    logger.error("core_process_unavailable_falling_back_to_local", {
      binary: corePath,
      error: String(err),
    });
  }
}

// Defaults for an auto-created run when a caller doesn't provide run_id
// (see handleExecuteTool). Generous enough that a one-off tool call
// never gets in its own way, while still being a real, persisted,
// per-call budget rather than the shared/global one this used to be.
const DEFAULT_RUN_MAX_STEPS = 50;
const DEFAULT_RUN_MAX_DELEGATION_DEPTH = 5;

// Background Task Engine foundation (master spec section 31) — document
// chunking runs here instead of inline in the HTTP request. Concurrency
// of 2 is a modest default for a single-process dev gateway; a real
// deployment would tune this or move to a real distributed queue (spec
// section 46).
const taskQueue = new TaskQueue(2);

// Rate limiting (master spec section 43). Defaults: 60 requests/minute
// sustained, burst up to 20 at once — generous for a single real client
// clicking around, restrictive enough to blunt casual abuse. Both
// configurable since the right numbers depend on deployment. Health
// checks are exempt (see the route handler below) so monitoring/load
// balancers polling /v1/health can't accidentally rate-limit themselves
// or get counted against a real client sharing their IP.
const RATE_LIMIT_CAPACITY = Number(process.env.AXORA_RATE_LIMIT_CAPACITY ?? 20);
const RATE_LIMIT_PER_SECOND = Number(process.env.AXORA_RATE_LIMIT_PER_SECOND ?? 1); // 60/min
const rateLimiter = new RateLimiter({ capacity: RATE_LIMIT_CAPACITY, refillPerSecond: RATE_LIMIT_PER_SECOND });
// Periodic housekeeping so long-lived processes don't accumulate one
// bucket per distinct IP forever; unref() so this timer alone never
// keeps the process alive.
setInterval(() => rateLimiter.evictIdle(10 * 60 * 1000), 60 * 1000).unref();

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

// Default 50MB: generous enough for a base64-encoded document/image
// upload (base64 is ~33% larger than the original bytes) while still
// bounding how much a single request can force the process to buffer
// into memory. Configurable since the right number depends on what's
// actually being uploaded in a given deployment.
const MAX_BODY_BYTES = Number(process.env.AXORA_MAX_BODY_BYTES ?? 50 * 1024 * 1024);

class PayloadTooLargeError extends Error {}

/**
 * Reads and JSON-parses a request body with a hard size cap. Before
 * this existed, a request body of any size — including one large
 * enough to exhaust the process's memory — would be buffered in full
 * before any validation ran. The cap is enforced incrementally (checked
 * per chunk, not after the fact), so an oversized body is rejected and
 * the connection torn down (`req.destroy()`) without ever finishing the
 * buffering.
 */
async function readJsonBody<T>(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      // Deliberately NOT req.destroy() here — a real bug found by
      // actually live-testing this over HTTP (curl got "Empty reply
      // from server" instead of a 413). req and res share the same
      // underlying TCP socket in Node's http module, so destroying the
      // request tears down the connection before any response can be
      // written on it, and the client sees a dead connection instead of
      // an error. Throwing without destroying leaves the socket intact
      // for parseJsonBody's caller to actually respond on; the
      // leftover unread body bytes are handled by closing the
      // connection *after* that response (see parseJsonBody) rather
      // than by killing the socket early.
      throw new PayloadTooLargeError(`request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

/**
 * Shared wrapper around readJsonBody that sends the right error
 * response itself (413 for oversized bodies, 400 for anything else —
 * malformed JSON, a stream error) and returns `undefined` to signal
 * "already responded, stop processing" — callers just do
 * `const body = await parseJsonBody<X>(req, res); if (!body) return;`.
 * This replaced 8 near-identical try/catch blocks that all handled
 * oversized-body and malformed-JSON the same (wrong) way; refactoring
 * to one shared function means the 413 fix applies everywhere at once,
 * not just wherever someone remembered to add it.
 */
async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    return await readJsonBody<T>(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      // The request body wasn't fully consumed (readJsonBody stopped
      // early), so there may be unread bytes still sitting on this
      // connection — reusing it for a subsequent keep-alive request
      // would misread those leftover bytes as the start of a new
      // request. Setting Connection: close tells both ends not to
      // reuse the socket; Node closes it after this response is sent,
      // which cleanly discards whatever's left instead of needing to
      // drain it.
      res.setHeader("connection", "close");
      sendJson(res, 413, { error: "payload_too_large", detail: err.message });
    } else {
      sendJson(res, 400, { error: "invalid_json" });
    }
    return undefined;
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, {
    status: "ok",
    service: "axora-gateway",
    providers: router.list().map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities })),
    time: new Date().toISOString(),
  });
}

async function handleListConversations(_req: IncomingMessage, res: ServerResponse) {
  const conversations = await store.listConversations();
  sendJson(res, 200, { conversations });
}

/**
 * Closes the gap named in Milestone 18's VERIFICATION entry: the web UI
 * could list conversations but had no way to replay a conversation's
 * history when switching to it. Store.getMessages() already existed
 * (used internally) — this just exposes it over HTTP.
 *
 * Deliberately does NOT call ensureConversation: that method creates a
 * row as a side effect, which would be wrong for a GET — a GET must
 * stay read-only. getMessages() on an unknown/empty conversation id
 * just returns an empty array, which is the correct, honest response
 * here (no messages yet), not an error.
 */
async function handleGetConversationMessages(res: ServerResponse, conversationId: string) {
  const messages = await store.getMessages(conversationId);
  sendJson(res, 200, { conversation_id: conversationId, messages });
}

async function handleAddMemory(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<MemoryInput>(req, res);
  if (!body) return;
  if (!body.content || !body.category || !body.source) {
    return sendJson(res, 400, { error: "content, category and source are required" });
  }
  const memory = await store.addMemory(body);
  sendJson(res, 201, { memory });
}

async function handleListMemories(_req: IncomingMessage, res: ServerResponse) {
  const memories = await store.listMemories();
  sendJson(res, 200, { memories });
}

async function handleIngestDocument(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<KnowledgeDocumentInput>(req, res);
  if (!body) return;
  if (!body.title || !body.content) {
    return sendJson(res, 400, { error: "title and content are required" });
  }

  // Chunking runs on the background task queue (spec section 31), not
  // inline in this request: the document row is created with status
  // "pending" immediately, chunking is enqueued, and the caller polls
  // GET /v1/knowledge/documents/:id (or the list endpoint) to see it
  // flip to "ready". For a small dev document this finishes in
  // milliseconds either way, but the point is the *contract* is now
  // right for a document large enough that it wouldn't be.
  const document = await store.createPendingDocument({
    title: body.title,
    sourceType: body.sourceType || "text",
    conversationId: body.conversationId ?? null,
  });
  taskQueue.enqueue(() => store.chunkAndFinalizeDocument(document.id, body.content).then(() => {}));

  sendJson(res, 202, { document });
}

async function handleListDocuments(_req: IncomingMessage, res: ServerResponse) {
  const documents = await store.listDocuments();
  sendJson(res, 200, { documents });
}

async function handleGetDocument(res: ServerResponse, documentId: string) {
  const document = await store.getDocument(documentId);
  if (!document) return sendJson(res, 404, { error: "document_not_found", id: documentId });
  sendJson(res, 200, { document });
}

/**
 * Real file ingestion: accepts base64-encoded bytes of an actual
 * document, and runs BOTH the parsing (Parsing pipeline stage) and the
 * chunking on the background task queue — not just chunking.
 *
 * This used to parse inline before responding, on the assumption that
 * "parsing is typically fast relative to chunking." That assumption
 * broke the moment OCR-backed parsers existed (ocrParser.ts,
 * scannedPdfOcr.ts, Milestones 11/13): OCR can easily be the slowest
 * part of the whole pipeline, which meant exactly the documents most in
 * need of a non-blocking response were the ones still blocking it. Only
 * the clearly-fast, clearly-synchronous validation (is sourceType
 * supported, is contentBase64 valid base64) stays inline — everything
 * that can be slow (parsing, chunking) now runs after the response.
 */
async function handleUploadDocument(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<{
    title?: string;
    sourceType?: string;
    contentBase64?: string;
    conversationId?: string | null;
  }>(req, res);
  if (!body) return;
  if (!body.title || !body.sourceType || !body.contentBase64) {
    return sendJson(res, 400, { error: "title, sourceType and contentBase64 are required" });
  }

  const parser = getParser(body.sourceType);
  if (!parser) {
    return sendJson(res, 400, {
      error: "unsupported_source_type",
      sourceType: body.sourceType,
      supported: supportedSourceTypes(),
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.contentBase64, "base64");
  } catch {
    return sendJson(res, 400, { error: "contentBase64 is not valid base64" });
  }

  const document = await store.createPendingDocument({
    title: body.title,
    sourceType: body.sourceType,
    conversationId: body.conversationId ?? null,
  });

  taskQueue.enqueue(async () => {
    let extractedText: string;
    try {
      extractedText = await parser.parse(buffer);
    } catch (err) {
      // Per "no fake capabilities": a parser that can't run reports the
      // real failure and the document ends up "failed" — never a
      // fabricated/empty document silently marked "ready".
      logger.error("document_parse_failed", {
        documentId: document.id,
        sourceType: body.sourceType,
        error: String(err),
      });
      await store.markDocumentFailed(document.id);
      return;
    }
    await store.chunkAndFinalizeDocument(document.id, extractedText);
  });

  sendJson(res, 202, { document });
}

async function handleExecuteTool(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<{ tool_name?: string; input?: string; run_id?: string }>(req, res);
  if (!body) return;
  if (!body.tool_name) {
    return sendJson(res, 400, { error: "tool_name is required" });
  }

  // Every tool call now runs against a real, persisted per-run budget —
  // no shared/global fallback. If the caller doesn't pass run_id, one is
  // created here with generous defaults, used for this single call, and
  // returned in the response so the caller can reuse it for follow-up
  // calls in the same logical run if they want continuity; if they
  // don't, each ad-hoc call just gets its own fresh (still real, still
  // persisted, still enforced) budget rather than a fabricated one.
  let run: NonNullable<Awaited<ReturnType<Store["getAgentRun"]>>>;
  if (body.run_id) {
    const existing = await store.getAgentRun(body.run_id);
    if (!existing) {
      return sendJson(res, 404, { error: "agent_run_not_found", run_id: body.run_id });
    }
    if (existing.status === "completed") {
      return sendJson(res, 409, { error: "agent_run_already_completed", run_id: body.run_id });
    }
    run = existing;
  } else {
    run = await store.createAgentRun({
      maxSteps: DEFAULT_RUN_MAX_STEPS,
      maxDelegationDepth: DEFAULT_RUN_MAX_DELEGATION_DEPTH,
    });
  }

  const scopedLimits = new RunLimits(run.max_steps, run.max_delegation_depth);
  scopedLimits.stepsTaken = run.step_count;
  const runner = new AgentRunner(toolRegistry, activePolicyProvider, scopedLimits);

  const outcome = await runner.step({ toolName: body.tool_name, input: body.input ?? "" });

  // Persist the run's new step count immediately after the attempt so a
  // denied/awaiting_approval step (which doesn't consume budget) doesn't
  // get miscounted, and an executed step's budget usage is never lost
  // even if something later in this request fails.
  if (outcome.type === "executed") {
    await store.setAgentRunStepCount(run.id, run.step_count + 1);
  }

  const tool = toolRegistry.get(body.tool_name);
  const resultStatusMap: Record<string, "success" | "failed" | "denied" | "awaiting_approval"> = {
    executed: "success",
    denied: "denied",
    awaiting_approval: "awaiting_approval",
    unknown_tool: "failed",
  };

  await store.logAction({
    action: body.tool_name,
    riskLevel: tool?.schema().riskLevel ?? "unknown",
    approved: outcome.type === "executed" ? true : outcome.type === "denied" ? false : null,
    resultStatus: resultStatusMap[outcome.type],
    detail: { outcome },
    toolName: body.tool_name,
    toolInput: body.input ?? "",
    runId: run.id,
  });

  const statusCode = outcome.type === "executed" ? 200 : outcome.type === "unknown_tool" ? 404 : 202;
  sendJson(res, statusCode, { outcome, run_id: run.id });
}

async function handleCreateAgentRun(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<Partial<AgentRunInput>>(req, res);
  if (!body) return;
  const run = await store.createAgentRun({
    maxSteps: body.maxSteps ?? 10,
    maxDelegationDepth: body.maxDelegationDepth ?? 3,
  });
  sendJson(res, 201, { run });
}

async function handleGetAgentRun(res: ServerResponse, runId: string) {
  const run = await store.getAgentRun(runId);
  if (!run) return sendJson(res, 404, { error: "agent_run_not_found", run_id: runId });
  sendJson(res, 200, { run });
}

/**
 * The approval-resume flow (closes the gap flagged at the end of
 * Milestone 4): a human decides on a previously `awaiting_approval`
 * action. Approving actually executes the tool now, respecting whatever
 * run budget the original request was scoped to; rejecting marks it
 * denied and stops there. Either way, the action log entry is updated
 * in place rather than a new one created, so its history stays linear.
 */
async function handleActionDecision(req: IncomingMessage, res: ServerResponse, actionId: string) {
  const body = await parseJsonBody<{ approved?: boolean }>(req, res);
  if (!body) return;
  if (typeof body.approved !== "boolean") {
    return sendJson(res, 400, { error: "approved (boolean) is required" });
  }

  // Atomic claim closes the race two concurrent decisions on the same
  // action used to be able to hit: the old code read the action, then
  // awaited tool.execute() before writing the final status, leaving a
  // window where a second concurrent request could pass the same
  // "is it awaiting_approval?" check and also execute the tool. Now
  // nothing proceeds past this point unless it, and only it, won the
  // claim — see Store.claimAction's doc comment.
  const claimed = await store.claimAction(actionId);
  if (!claimed) {
    const existing = await store.getAction(actionId);
    if (!existing) return sendJson(res, 404, { error: "action_not_found", id: actionId });
    return sendJson(res, 409, {
      error: "action_not_awaiting_approval",
      current_status: existing.resultStatus,
    });
  }
  const action = claimed;

  if (!body.approved) {
    const updated = await store.updateAction(actionId, {
      approved: false,
      resultStatus: "denied",
      detail: { ...action.detail, decision: "rejected_by_user" },
    });
    return sendJson(res, 200, { action: updated });
  }

  // Approved: actually run it now. This bypasses PolicyEngine.evaluate
  // (a human already made the approval decision the policy engine would
  // have asked for) but still goes through the real tool and still
  // respects/updates the associated run's step budget if there was one.
  const tool = action.toolName ? toolRegistry.get(action.toolName) : undefined;
  if (!tool) {
    const updated = await store.updateAction(actionId, {
      approved: true,
      resultStatus: "failed",
      detail: { ...action.detail, decision: "approved_but_tool_no_longer_registered" },
    });
    return sendJson(res, 409, { action: updated });
  }

  try {
    const output = await tool.execute(action.toolInput ?? "");
    if (action.runId) {
      const run = await store.getAgentRun(action.runId);
      if (run) await store.setAgentRunStepCount(action.runId, run.step_count + 1);
    }
    const updated = await store.updateAction(actionId, {
      approved: true,
      resultStatus: "success",
      detail: { ...action.detail, decision: "approved_by_user", output },
    });
    return sendJson(res, 200, { action: updated });
  } catch (err) {
    const updated = await store.updateAction(actionId, {
      approved: true,
      resultStatus: "failed",
      detail: { ...action.detail, decision: "approved_by_user", error: String(err) },
    });
    return sendJson(res, 500, { action: updated });
  }
}

async function handleListTools(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, { tools: toolRegistry.list() });
}

async function handleListActions(_req: IncomingMessage, res: ServerResponse) {
  const actions = await store.listActions();
  sendJson(res, 200, { actions });
}

/**
 * Secret Vault HTTP surface (master spec section 26). Deliberately only
 * three operations: set, list names, delete. There is NO endpoint that
 * returns a secret's decrypted value — SecretVault.getSecret() exists
 * for internal code to call, never for an HTTP client.
 */
function requireVault(res: ServerResponse): SecretVault | undefined {
  if (!secretVault) {
    sendJson(res, 503, {
      error: "secret_vault_not_configured",
      detail: "Set AXORA_SECRET_KEY to enable the Secret Vault.",
    });
    return undefined;
  }
  return secretVault;
}

async function handleSetSecret(req: IncomingMessage, res: ServerResponse) {
  const vault = requireVault(res);
  if (!vault) return;

  const body = await parseJsonBody<{ name?: string; value?: string }>(req, res);
  if (!body) return;
  if (!body.name || typeof body.value !== "string") {
    return sendJson(res, 400, { error: "name and value are required" });
  }

  try {
    await vault.setSecret(body.name, body.value);
    sendJson(res, 201, { name: body.name });
  } catch (err) {
    logger.error("vault_set_failed", { name: body.name, error: String(err) });
    sendJson(res, 500, { error: "vault_operation_failed", detail: String(err) });
  }
}

async function handleListSecrets(_req: IncomingMessage, res: ServerResponse) {
  const vault = requireVault(res);
  if (!vault) return;
  const names = await vault.listSecretNames();
  sendJson(res, 200, { names });
}

async function handleDeleteSecret(res: ServerResponse, name: string) {
  const vault = requireVault(res);
  if (!vault) return;
  const deleted = await vault.deleteSecret(name);
  if (!deleted) return sendJson(res, 404, { error: "secret_not_found", name });
  sendJson(res, 200, { deleted: true, name });
}

/**
 * Context Engine (master spec section 62/65) — the part of this that's
 * implemented today: combine the conversation's own messages with
 * relevant long-term memories into what the provider actually sees.
 * Ranking/dedup/compression beyond "top-K relevant memories" is future
 * work; this is real, not a stub — see memory/retrieval.ts.
 *
 * Scoped to `conversationId`: only global memories/chunks (created with
 * no conversationId) plus this conversation's own are considered —
 * see Store.listMemoriesForContext / listChunksForContext. Before this,
 * every memory and knowledge chunk in the whole gateway was visible to
 * every conversation regardless of where it came from, which is a real
 * correctness problem for anything beyond a single-user single-topic demo.
 */
async function assembleContext(messages: ChatMessage[], conversationId: string): Promise<ChatMessage[]> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return messages;

  const [scopedMemories, scopedChunks] = await Promise.all([
    store.listMemoriesForContext(conversationId),
    store.listChunksForContext(conversationId),
  ]);

  const relevantMemories = retrieveMemories(lastUser.content, scopedMemories, 5);
  const relevantChunks = retrieveChunks(lastUser.content, scopedChunks, 3);

  logger.info("context_assembly", {
    query: lastUser.content,
    conversation_id: conversationId,
    scoped_memories: scopedMemories.length,
    relevant_memories: relevantMemories.map((m) => ({ id: m.id, score: Number(m.score.toFixed(3)) })),
    scoped_chunks: scopedChunks.length,
    relevant_chunks: relevantChunks.map((c) => ({ id: c.id, score: Number(c.score.toFixed(3)) })),
  });

  if (relevantMemories.length === 0 && relevantChunks.length === 0) return messages;

  const sections: string[] = [];
  if (relevantMemories.length > 0) {
    sections.push(
      "Relevant long-term memory (retrieved by keyword relevance, not semantic search):\n" +
        relevantMemories.map((m) => `- [${m.category}] ${m.content}`).join("\n"),
    );
  }
  if (relevantChunks.length > 0) {
    sections.push(
      "Relevant Knowledge Vault excerpts (retrieved by keyword relevance, not semantic search):\n" +
        relevantChunks
          .map((c) => `- (from "${c.document_title}") ${c.content}`)
          .join("\n"),
    );
  }

  const contextMessage: ChatMessage = { role: "system", content: sections.join("\n\n") };
  return [contextMessage, ...messages];
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody<ChatCompletionRequest>(req, res);
  if (!body) return;

  if (!body.conversation_id || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, { error: "conversation_id and non-empty messages[] are required" });
  }

  await store.ensureConversation(body.conversation_id);

  const lastMessage: ChatMessage | undefined = body.messages[body.messages.length - 1];
  if (lastMessage?.role === "user") {
    await store.appendMessage(body.conversation_id, lastMessage);
  }

  const provider = router.resolve({ mode: body.mode, providerId: body.provider });
  const contextualMessages = await assembleContext(body.messages, body.conversation_id);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-axora-provider": provider.id,
  });

  let fullText = "";
  try {
    for await (const chunk of provider.stream(contextualMessages)) {
      fullText += chunk.delta;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (chunk.done) break;
    }
  } catch (err) {
    logger.error("provider_stream_failed", { error: String(err) });
    // Per "no fake capabilities": report the real failure, do not
    // fabricate a completion.
    res.write(`data: ${JSON.stringify({ delta: "", done: true, error: String(err) })}\n\n`);
    return res.end();
  }

  await store.appendMessage(body.conversation_id, { role: "assistant", content: fullText });
  res.end();
}

function applyCors(res: ServerResponse) {
  // Permissive dev CORS so the static/Next.js web client can call the
  // gateway from a different origin during local development. Tighten
  // this to an allow-list before anything is deployed publicly.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

async function main() {
  const selected = await createStore();
  store = selected.store;
  router = new ModelRouter(await createProviders(), "mock");
  await selectPolicyProvider();

  if (process.env.AXORA_SECRET_KEY) {
    secretVault = new SecretVault(store, process.env.AXORA_SECRET_KEY);
    logger.info("secret_vault_enabled", {});
  } else {
    logger.info("secret_vault_disabled", { reason: "AXORA_SECRET_KEY not set" });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    applyCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // Rate limit everything except the health check (see the comment on
    // rateLimiter's construction above for why health is exempt).
    if (url.pathname !== "/v1/health") {
      const clientKey = req.socket.remoteAddress ?? "unknown";
      const result = rateLimiter.tryConsume(clientKey);
      if (!result.allowed) {
        res.setHeader("retry-after", String(result.retryAfterSeconds));
        return sendJson(res, 429, {
          error: "rate_limited",
          retry_after_seconds: result.retryAfterSeconds,
        });
      }
    }

    try {
      if (req.method === "GET" && url.pathname === "/v1/health") {
        return await handleHealth(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/conversations") {
        return await handleListConversations(req, res);
      }
      {
        const convMessagesMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
        if (req.method === "GET" && convMessagesMatch) {
          return await handleGetConversationMessages(res, decodeURIComponent(convMessagesMatch[1]));
        }
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleChatCompletions(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/memories") {
        return await handleAddMemory(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/memories") {
        return await handleListMemories(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/knowledge/documents") {
        return await handleIngestDocument(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/knowledge/documents") {
        return await handleListDocuments(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/knowledge/documents/upload") {
        return await handleUploadDocument(req, res);
      }
      {
        const docMatch = url.pathname.match(/^\/v1\/knowledge\/documents\/([^/]+)$/);
        if (req.method === "GET" && docMatch) {
          return await handleGetDocument(res, docMatch[1]);
        }
      }
      if (req.method === "POST" && url.pathname === "/v1/tools/execute") {
        return await handleExecuteTool(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/tools") {
        return await handleListTools(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/action-log") {
        return await handleListActions(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/vault/secrets") {
        return await handleSetSecret(req, res);
      }
      if (req.method === "GET" && url.pathname === "/v1/vault/secrets") {
        return await handleListSecrets(req, res);
      }
      {
        const secretMatch = url.pathname.match(/^\/v1\/vault\/secrets\/([^/]+)$/);
        if (req.method === "DELETE" && secretMatch) {
          return await handleDeleteSecret(res, decodeURIComponent(secretMatch[1]));
        }
      }
      {
        const decisionMatch = url.pathname.match(/^\/v1\/action-log\/([^/]+)\/decision$/);
        if (req.method === "POST" && decisionMatch) {
          return await handleActionDecision(req, res, decisionMatch[1]);
        }
      }
      if (req.method === "POST" && url.pathname === "/v1/agent-runs") {
        return await handleCreateAgentRun(req, res);
      }
      {
        const runMatch = url.pathname.match(/^\/v1\/agent-runs\/([^/]+)$/);
        if (req.method === "GET" && runMatch) {
          return await handleGetAgentRun(res, runMatch[1]);
        }
      }
      sendJson(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      logger.error("unhandled_error", { error: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  });

  server.listen(PORT, () => {
    logger.info("axora_gateway_listening", { port: PORT, store: selected.kind });
  });
}

main().catch((err) => {
  logger.error("gateway_startup_failed", { error: String(err) });
  process.exit(1);
});
