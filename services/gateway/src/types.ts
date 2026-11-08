// Shared domain types. Deliberately framework-free so they can be reused by
// a future Postgres store, the Rust core (via generated bindings), and SDKs.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Model routing modes, per master spec section 4 / 61. */
export type RouteMode =
  | "auto"
  | "fast"
  | "deep"
  | "research"
  | "creative"
  | "coding"
  | "study";

export interface ChatCompletionRequest {
  conversation_id: string;
  messages: ChatMessage[];
  mode?: RouteMode;
  /** Explicit provider override — bypasses the router when set. */
  provider?: string;
}

export interface StreamChunk {
  /** Incremental text delta. */
  delta: string;
  done: boolean;
  /** Present only on the final chunk. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface StoredConversation {
  id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  conversation_id: string;
  created_at: string;
}

/** Memory categories, per master spec section 12. */
export type MemoryCategory = "fact" | "preference" | "goal" | "instruction" | "relationship";

export interface MemoryInput {
  category: MemoryCategory;
  content: string;
  source: "chat" | "import" | "manual";
  importance?: number; // 0..1, default 0.5
  /**
   * Scope this memory to one conversation instead of making it globally
   * visible. Omitted/null = global (visible to every conversation's
   * context assembly) — the original, still-supported behavior.
   */
  conversationId?: string | null;
}

export interface StoredMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  source: string;
  confidence: number;
  importance: number;
  conversation_id: string | null;
  created_at: string;
}

export interface RetrievedMemory extends StoredMemory {
  /** Relevance score for this retrieval query — see memory/retrieval.ts. */
  score: number;
}

/** Knowledge Vault types (master spec sections 13-14). */
export interface KnowledgeDocumentInput {
  title: string;
  sourceType: string; // "text" | "md" | "pasted" | ... (parsers land later)
  content: string;
  /** Same scoping model as MemoryInput.conversationId — see there. */
  conversationId?: string | null;
}

export interface StoredKnowledgeDocument {
  id: string;
  title: string;
  source_type: string;
  status: string; // pending|chunking|ready|failed
  conversation_id: string | null;
  created_at: string;
}

export interface StoredKnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  created_at: string;
}

export interface RetrievedChunk extends StoredKnowledgeChunk {
  score: number;
  document_title: string;
}

/** Action log entry — master spec section 27. */
export interface ActionLogInput {
  action: string;
  riskLevel: string;
  approved: boolean | null; // null = not yet decided (awaiting_approval)
  // "deciding" is a short-lived transient state set atomically by
  // Store.claimAction — see server.ts's handleActionDecision comment on
  // the concurrent-decision race it closes.
  resultStatus: "pending" | "success" | "failed" | "denied" | "awaiting_approval" | "deciding";
  detail?: Record<string, unknown>;
  /** Present when this action can be resumed later via the approval endpoint. */
  toolName?: string;
  toolInput?: string;
  runId?: string | null;
}

export interface StoredActionLogEntry extends ActionLogInput {
  id: string;
  created_at: string;
}

/** Secret Vault — master spec section 26. Stores only the encrypted payload; plaintext never persists. */
export interface StoredSecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Agent run — master spec's `agent_runs` table, gives each run its own step budget. */
export interface AgentRunInput {
  maxSteps: number;
  maxDelegationDepth: number;
}

export interface StoredAgentRun {
  id: string;
  status: "pending" | "running" | "completed" | "cancelled";
  step_count: number;
  max_steps: number;
  max_delegation_depth: number;
  started_at: string;
  finished_at: string | null;
}

