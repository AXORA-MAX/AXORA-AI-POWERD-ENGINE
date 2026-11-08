import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ActionLogInput,
  AgentRunInput,
  ChatMessage,
  KnowledgeDocumentInput,
  MemoryInput,
  StoredActionLogEntry,
  StoredAgentRun,
  StoredConversation,
  StoredKnowledgeChunk,
  StoredKnowledgeDocument,
  StoredMemory,
  StoredMessage,
  StoredSecretRow,
} from "./types.js";
import { chunkText } from "./knowledge/chunking.js";

/**
 * Storage abstraction. The interface is the contract the rest of the
 * gateway depends on; SqliteStore is the local-dev implementation.
 * PostgresStore (postgresStore.ts) implements the same interface against
 * the schema in db/migrations/0001_init.sql — see README for its
 * verification status (written, not executable in this sandbox).
 */
export interface Store {
  ensureConversation(id: string): Promise<StoredConversation>;
  appendMessage(conversationId: string, message: ChatMessage): Promise<StoredMessage>;
  getMessages(conversationId: string): Promise<StoredMessage[]>;
  listConversations(): Promise<StoredConversation[]>;

  addMemory(input: MemoryInput): Promise<StoredMemory>;
  listMemories(): Promise<StoredMemory[]>;
  /** Global memories (conversation_id IS NULL) plus this conversation's own — what context assembly actually uses. */
  listMemoriesForContext(conversationId: string): Promise<StoredMemory[]>;

  ingestDocument(input: KnowledgeDocumentInput): Promise<StoredKnowledgeDocument>;
  listDocuments(): Promise<StoredKnowledgeDocument[]>;
  getDocument(id: string): Promise<StoredKnowledgeDocument | undefined>;
  /** Insert a document row immediately with status "pending" and no chunks yet — the fast half of background ingestion (see TaskQueue). */
  createPendingDocument(
    input: Pick<KnowledgeDocumentInput, "title" | "sourceType" | "conversationId">,
  ): Promise<StoredKnowledgeDocument>;
  /** The slow half: chunk `content` and attach it to an already-created document, then flip its status to ready/failed. */
  chunkAndFinalizeDocument(documentId: string, content: string): Promise<StoredKnowledgeDocument>;
  /** Marks a pending document failed directly — used when parsing itself (not just chunking) fails inside the background task. */
  markDocumentFailed(documentId: string): Promise<StoredKnowledgeDocument | undefined>;
  listChunksWithTitles(): Promise<(StoredKnowledgeChunk & { document_title: string })[]>;
  /** Global chunks plus this conversation's own — what context assembly actually uses. */
  listChunksForContext(
    conversationId: string,
  ): Promise<(StoredKnowledgeChunk & { document_title: string })[]>;

  logAction(input: ActionLogInput): Promise<StoredActionLogEntry>;
  listActions(): Promise<StoredActionLogEntry[]>;
  getAction(id: string): Promise<StoredActionLogEntry | undefined>;
  /**
   * Atomically transition an action from "awaiting_approval" to
   * "deciding" — a single UPDATE ... WHERE result_status = 'awaiting_approval'
   * statement, so it either claims the action (and nothing else can) or
   * finds it already claimed/resolved and returns undefined. This is
   * what actually closes the concurrent-decision race: the old
   * read-then-later-write pattern had an await gap (tool.execute())
   * between checking status and finalizing it, wide enough for two
   * concurrent decisions to both pass the check.
   */
  claimAction(id: string): Promise<StoredActionLogEntry | undefined>;
  updateAction(
    id: string,
    update: Partial<Pick<ActionLogInput, "approved" | "resultStatus" | "detail">>,
  ): Promise<StoredActionLogEntry | undefined>;

  createAgentRun(input: AgentRunInput): Promise<StoredAgentRun>;
  getAgentRun(id: string): Promise<StoredAgentRun | undefined>;
  setAgentRunStepCount(id: string, stepCount: number): Promise<StoredAgentRun | undefined>;

  /** Secret Vault persistence — stores only the encrypted payload, never plaintext. */
  upsertSecret(name: string, payload: { ciphertext: string; iv: string; authTag: string }): Promise<StoredSecretRow>;
  getSecretRow(name: string): Promise<StoredSecretRow | undefined>;
  deleteSecretRow(name: string): Promise<boolean>;
  listSecretNames(): Promise<string[]>;
}

/**
 * Real, working local-dev store using Node's built-in SQLite (no external
 * dependency, no network, no install step). Schema intentionally mirrors
 * the `conversations` / `messages` tables in db/migrations/0001_init.sql
 * so moving to PostgresStore later is a drop-in swap.
 */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        conversation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        conversation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approved INTEGER,
        result_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_secrets (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        step_count INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL,
        max_delegation_depth INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
  }

  async ensureConversation(id: string): Promise<StoredConversation> {
    const existing = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as StoredConversation | undefined;
    if (existing) return existing;

    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)",
      )
      .run(id, now, now);
    return { id, title: null, created_at: now, updated_at: now };
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<StoredMessage> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, conversationId, message.role, message.content, now);
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, conversationId);
    return { id, conversation_id: conversationId, role: message.role, content: message.content, created_at: now };
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as unknown as StoredMessage[];
  }

  async listConversations(): Promise<StoredConversation[]> {
    return this.db
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
      .all() as unknown as StoredConversation[];
  }

  async addMemory(input: MemoryInput): Promise<StoredMemory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const importance = input.importance ?? 0.5;
    const conversationId = input.conversationId ?? null;
    this.db
      .prepare(
        `INSERT INTO memories (id, category, content, source, confidence, importance, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.category, input.content, input.source, 1.0, importance, conversationId, now);
    return {
      id,
      category: input.category,
      content: input.content,
      source: input.source,
      confidence: 1.0,
      importance,
      conversation_id: conversationId,
      created_at: now,
    };
  }

  async listMemories(): Promise<StoredMemory[]> {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY created_at DESC")
      .all() as unknown as StoredMemory[];
  }

  async listMemoriesForContext(conversationId: string): Promise<StoredMemory[]> {
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE conversation_id IS NULL OR conversation_id = ? ORDER BY created_at DESC",
      )
      .all(conversationId) as unknown as StoredMemory[];
  }

  async createPendingDocument(
    input: Pick<KnowledgeDocumentInput, "title" | "sourceType" | "conversationId">,
  ): Promise<StoredKnowledgeDocument> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const conversationId = input.conversationId ?? null;
    this.db
      .prepare(
        "INSERT INTO knowledge_documents (id, title, source_type, status, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.title, input.sourceType, "pending", conversationId, now);
    return {
      id,
      title: input.title,
      source_type: input.sourceType,
      status: "pending",
      conversation_id: conversationId,
      created_at: now,
    };
  }

  async chunkAndFinalizeDocument(documentId: string, content: string): Promise<StoredKnowledgeDocument> {
    this.db
      .prepare("UPDATE knowledge_documents SET status = 'chunking' WHERE id = ?")
      .run(documentId);

    const chunks = chunkText(content);
    for (const c of chunks) {
      this.db
        .prepare(
          "INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), documentId, c.index, c.content, new Date().toISOString());
    }

    const finalStatus = chunks.length > 0 ? "ready" : "failed";
    this.db
      .prepare("UPDATE knowledge_documents SET status = ? WHERE id = ?")
      .run(finalStatus, documentId);

    const updated = await this.getDocument(documentId);
    if (!updated) throw new Error(`chunkAndFinalizeDocument: document ${documentId} vanished mid-pipeline`);
    return updated;
  }

  /** Synchronous convenience wrapper (create + chunk in one call) — still used by anything that wants the old inline behavior, e.g. direct store-level tests. */
  async ingestDocument(input: KnowledgeDocumentInput): Promise<StoredKnowledgeDocument> {
    const doc = await this.createPendingDocument(input);
    return this.chunkAndFinalizeDocument(doc.id, input.content);
  }

  async listDocuments(): Promise<StoredKnowledgeDocument[]> {
    return this.db
      .prepare("SELECT * FROM knowledge_documents ORDER BY created_at DESC")
      .all() as unknown as StoredKnowledgeDocument[];
  }

  async getDocument(id: string): Promise<StoredKnowledgeDocument | undefined> {
    return this.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id) as
      | StoredKnowledgeDocument
      | undefined;
  }

  async markDocumentFailed(id: string): Promise<StoredKnowledgeDocument | undefined> {
    this.db.prepare("UPDATE knowledge_documents SET status = 'failed' WHERE id = ?").run(id);
    return this.getDocument(id);
  }

  async listChunksWithTitles(): Promise<(StoredKnowledgeChunk & { document_title: string })[]> {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at, d.title AS document_title
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
         ORDER BY c.created_at ASC`,
      )
      .all() as unknown as (StoredKnowledgeChunk & { document_title: string })[];
  }

  async listChunksForContext(
    conversationId: string,
  ): Promise<(StoredKnowledgeChunk & { document_title: string })[]> {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at, d.title AS document_title
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
         WHERE d.conversation_id IS NULL OR d.conversation_id = ?
         ORDER BY c.created_at ASC`,
      )
      .all(conversationId) as unknown as (StoredKnowledgeChunk & { document_title: string })[];
  }

  async logAction(input: ActionLogInput): Promise<StoredActionLogEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const detailJson = JSON.stringify(input.detail ?? {});
    this.db
      .prepare(
        `INSERT INTO action_log (id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.action,
        input.riskLevel,
        input.approved === null || input.approved === undefined ? null : input.approved ? 1 : 0,
        input.resultStatus,
        detailJson,
        input.toolName ?? null,
        input.toolInput ?? null,
        input.runId ?? null,
        now,
      );
    return { id, created_at: now, ...input };
  }

  private rowToAction(r: any): StoredActionLogEntry {
    return {
      id: r.id,
      action: r.action,
      riskLevel: r.risk_level,
      approved: r.approved === null ? null : Boolean(r.approved),
      resultStatus: r.result_status,
      detail: JSON.parse(r.detail),
      toolName: r.tool_name ?? undefined,
      toolInput: r.tool_input ?? undefined,
      runId: r.run_id ?? null,
      created_at: r.created_at,
    };
  }

  async listActions(): Promise<StoredActionLogEntry[]> {
    const rows = this.db.prepare("SELECT * FROM action_log ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => this.rowToAction(r));
  }

  async getAction(id: string): Promise<StoredActionLogEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM action_log WHERE id = ?").get(id) as any;
    return row ? this.rowToAction(row) : undefined;
  }

  // Deliberately no `await` anywhere in this method before the DB call
  // returns — node:sqlite's .run() is synchronous, so this entire
  // check-and-set happens as one uninterruptible step of the event loop.
  // That, not any explicit locking, is what makes it race-safe: see the
  // Store interface doc comment and services/gateway/src/core/agent.test.ts
  // -style reasoning in claimAction.test.ts.
  async claimAction(id: string): Promise<StoredActionLogEntry | undefined> {
    const result = this.db
      .prepare("UPDATE action_log SET result_status = 'deciding' WHERE id = ? AND result_status = 'awaiting_approval'")
      .run(id);
    if (result.changes === 0) return undefined;
    return this.getAction(id);
  }

  async updateAction(
    id: string,
    update: Partial<Pick<ActionLogInput, "approved" | "resultStatus" | "detail">>,
  ): Promise<StoredActionLogEntry | undefined> {
    const existing = await this.getAction(id);
    if (!existing) return undefined;

    const approved = update.approved !== undefined ? update.approved : existing.approved;
    const resultStatus = update.resultStatus ?? existing.resultStatus;
    const detail = update.detail ?? existing.detail;

    this.db
      .prepare("UPDATE action_log SET approved = ?, result_status = ?, detail = ? WHERE id = ?")
      .run(approved === null ? null : approved ? 1 : 0, resultStatus, JSON.stringify(detail ?? {}), id);

    return this.getAction(id);
  }

  async createAgentRun(input: AgentRunInput): Promise<StoredAgentRun> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, status, step_count, max_steps, max_delegation_depth, started_at, finished_at)
         VALUES (?, 'running', 0, ?, ?, ?, NULL)`,
      )
      .run(id, input.maxSteps, input.maxDelegationDepth, now);
    return {
      id,
      status: "running",
      step_count: 0,
      max_steps: input.maxSteps,
      max_delegation_depth: input.maxDelegationDepth,
      started_at: now,
      finished_at: null,
    };
  }

  async getAgentRun(id: string): Promise<StoredAgentRun | undefined> {
    return this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | StoredAgentRun
      | undefined;
  }

  async setAgentRunStepCount(id: string, stepCount: number): Promise<StoredAgentRun | undefined> {
    const run = await this.getAgentRun(id);
    if (!run) return undefined;
    const status = stepCount >= run.max_steps ? "completed" : "running";
    const finishedAt = status === "completed" ? new Date().toISOString() : null;
    this.db
      .prepare("UPDATE agent_runs SET step_count = ?, status = ?, finished_at = ? WHERE id = ?")
      .run(stepCount, status, finishedAt, id);
    return this.getAgentRun(id);
  }

  async upsertSecret(
    name: string,
    payload: { ciphertext: string; iv: string; authTag: string },
  ): Promise<StoredSecretRow> {
    const now = new Date().toISOString();
    const existing = await this.getSecretRow(name);
    const version = (existing?.version ?? 0) + 1;

    if (existing) {
      this.db
        .prepare(
          "UPDATE vault_secrets SET ciphertext = ?, iv = ?, auth_tag = ?, version = ?, updated_at = ? WHERE name = ?",
        )
        .run(payload.ciphertext, payload.iv, payload.authTag, version, now, name);
    } else {
      this.db
        .prepare(
          `INSERT INTO vault_secrets (name, ciphertext, iv, auth_tag, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(name, payload.ciphertext, payload.iv, payload.authTag, version, now, now);
    }
    return (await this.getSecretRow(name))!;
  }

  async getSecretRow(name: string): Promise<StoredSecretRow | undefined> {
    const row = this.db.prepare("SELECT * FROM vault_secrets WHERE name = ?").get(name) as any;
    if (!row) return undefined;
    return {
      name: row.name,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async deleteSecretRow(name: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM vault_secrets WHERE name = ?").run(name);
    return result.changes > 0;
  }

  async listSecretNames(): Promise<string[]> {
    const rows = this.db.prepare("SELECT name FROM vault_secrets ORDER BY name ASC").all() as any[];
    return rows.map((r) => r.name);
  }
}
