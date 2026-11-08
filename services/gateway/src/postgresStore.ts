import { Pool } from "pg";
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
import type { Store } from "./store.js";
import { chunkText } from "./knowledge/chunking.js";

/**
 * Production Store implementation against db/migrations/0001_init.sql.
 *
 * VERIFICATION STATUS: written, not executed. This sandbox has neither a
 * running PostgreSQL server nor network access to install the `pg`
 * package it imports, so this class has never actually connected to a
 * database. It is included because it's the correct next artifact per
 * the master spec ("continue from the existing architecture"), and its
 * SQL is straightforward parameterized CRUD against a schema that *was*
 * reviewed — but treat it as unverified until you run it yourself:
 *
 *   npm install pg
 *   psql "$DATABASE_URL" -f db/migrations/0001_init.sql
 *   DATABASE_URL=postgres://... npm start
 *
 * Every query is parameterized ($1, $2, ...) — no string-interpolated
 * SQL — so this doesn't reintroduce the injection risk a hand-rolled
 * query builder would.
 */
export class PostgresStore implements Store {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureConversation(id: string): Promise<StoredConversation> {
    const existing = await this.pool.query<StoredConversation>(
      "SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1",
      [id],
    );
    if (existing.rows[0]) return existing.rows[0];

    const inserted = await this.pool.query<StoredConversation>(
      `INSERT INTO conversations (id, title)
       VALUES ($1, NULL)
       RETURNING id, title, created_at, updated_at`,
      [id],
    );
    return inserted.rows[0];
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<StoredMessage> {
    const inserted = await this.pool.query<StoredMessage>(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id, conversation_id, role, content, created_at`,
      [conversationId, message.role, message.content],
    );
    await this.pool.query(
      "UPDATE conversations SET updated_at = now() WHERE id = $1",
      [conversationId],
    );
    return inserted.rows[0];
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    const result = await this.pool.query<StoredMessage>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return result.rows;
  }

  async listConversations(): Promise<StoredConversation[]> {
    const result = await this.pool.query<StoredConversation>(
      "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC",
    );
    return result.rows;
  }

  async addMemory(input: MemoryInput): Promise<StoredMemory> {
    const importance = input.importance ?? 0.5;
    const result = await this.pool.query<StoredMemory>(
      `INSERT INTO memories (user_id, category, content, source, confidence, importance, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, category, content, source, confidence, importance, conversation_id, created_at`,
      // user_id hardcoded null-equivalent placeholder until auth/session
      // wiring lands — the column is nullable specifically for this reason
      // (see the migration's comment on memories.user_id).
      [null, input.category, input.content, input.source, 1.0, importance, input.conversationId ?? null],
    );
    return result.rows[0];
  }

  async listMemories(): Promise<StoredMemory[]> {
    const result = await this.pool.query<StoredMemory>(
      `SELECT id, category, content, source, confidence, importance, conversation_id, created_at
       FROM memories ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  async listMemoriesForContext(conversationId: string): Promise<StoredMemory[]> {
    const result = await this.pool.query<StoredMemory>(
      `SELECT id, category, content, source, confidence, importance, conversation_id, created_at
       FROM memories WHERE conversation_id IS NULL OR conversation_id = $1
       ORDER BY created_at DESC`,
      [conversationId],
    );
    return result.rows;
  }

  async createPendingDocument(
    input: Pick<KnowledgeDocumentInput, "title" | "sourceType" | "conversationId">,
  ): Promise<StoredKnowledgeDocument> {
    const result = await this.pool.query<StoredKnowledgeDocument>(
      `INSERT INTO knowledge_documents (title, source_type, status, conversation_id)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id, title, source_type, status, conversation_id, created_at`,
      [input.title, input.sourceType, input.conversationId ?? null],
    );
    return result.rows[0];
  }

  async chunkAndFinalizeDocument(documentId: string, content: string): Promise<StoredKnowledgeDocument> {
    await this.pool.query("UPDATE knowledge_documents SET status = 'chunking' WHERE id = $1", [documentId]);

    const chunks = chunkText(content);
    for (const c of chunks) {
      await this.pool.query(
        `INSERT INTO knowledge_chunks (document_id, chunk_index, content)
         VALUES ($1, $2, $3)`,
        [documentId, c.index, c.content],
      );
    }

    const finalStatus = chunks.length > 0 ? "ready" : "failed";
    const result = await this.pool.query<StoredKnowledgeDocument>(
      `UPDATE knowledge_documents SET status = $1 WHERE id = $2
       RETURNING id, title, source_type, status, conversation_id, created_at`,
      [finalStatus, documentId],
    );
    return result.rows[0];
  }

  /** Synchronous convenience wrapper (create + chunk in one call) — still used by anything that wants the old inline behavior. */
  async ingestDocument(input: KnowledgeDocumentInput): Promise<StoredKnowledgeDocument> {
    const doc = await this.createPendingDocument(input);
    return this.chunkAndFinalizeDocument(doc.id, input.content);
  }

  async listDocuments(): Promise<StoredKnowledgeDocument[]> {
    const result = await this.pool.query<StoredKnowledgeDocument>(
      "SELECT id, title, source_type, status, conversation_id, created_at FROM knowledge_documents ORDER BY created_at DESC",
    );
    return result.rows;
  }

  async getDocument(id: string): Promise<StoredKnowledgeDocument | undefined> {
    const result = await this.pool.query<StoredKnowledgeDocument>(
      "SELECT id, title, source_type, status, conversation_id, created_at FROM knowledge_documents WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  async markDocumentFailed(id: string): Promise<StoredKnowledgeDocument | undefined> {
    const result = await this.pool.query<StoredKnowledgeDocument>(
      `UPDATE knowledge_documents SET status = 'failed' WHERE id = $1
       RETURNING id, title, source_type, status, conversation_id, created_at`,
      [id],
    );
    return result.rows[0];
  }

  async listChunksWithTitles(): Promise<(StoredKnowledgeChunk & { document_title: string })[]> {
    const result = await this.pool.query<StoredKnowledgeChunk & { document_title: string }>(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at, d.title AS document_title
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       ORDER BY c.created_at ASC`,
    );
    return result.rows;
  }

  async listChunksForContext(
    conversationId: string,
  ): Promise<(StoredKnowledgeChunk & { document_title: string })[]> {
    const result = await this.pool.query<StoredKnowledgeChunk & { document_title: string }>(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at, d.title AS document_title
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       WHERE d.conversation_id IS NULL OR d.conversation_id = $1
       ORDER BY c.created_at ASC`,
      [conversationId],
    );
    return result.rows;
  }

  async logAction(input: ActionLogInput): Promise<StoredActionLogEntry> {
    const result = await this.pool.query<any>(
      `INSERT INTO action_log (action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at`,
      [
        input.action,
        input.riskLevel,
        input.approved ?? null,
        input.resultStatus,
        JSON.stringify(input.detail ?? {}),
        input.toolName ?? null,
        input.toolInput ?? null,
        input.runId ?? null,
      ],
    );
    return this.rowToAction(result.rows[0]);
  }

  private rowToAction(row: any): StoredActionLogEntry {
    return {
      id: row.id,
      action: row.action,
      riskLevel: row.risk_level,
      approved: row.approved,
      resultStatus: row.result_status,
      detail: row.detail,
      toolName: row.tool_name ?? undefined,
      toolInput: row.tool_input ?? undefined,
      runId: row.run_id ?? null,
      created_at: row.created_at,
    };
  }

  async listActions(): Promise<StoredActionLogEntry[]> {
    const result = await this.pool.query<any>(
      "SELECT id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at FROM action_log ORDER BY created_at DESC",
    );
    return result.rows.map((row) => this.rowToAction(row));
  }

  async getAction(id: string): Promise<StoredActionLogEntry | undefined> {
    const result = await this.pool.query<any>(
      "SELECT id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at FROM action_log WHERE id = $1",
      [id],
    );
    return result.rows[0] ? this.rowToAction(result.rows[0]) : undefined;
  }

  /**
   * Atomic claim via a single UPDATE ... WHERE ... RETURNING statement —
   * this is the real, production version of the race fix: correct
   * regardless of how many gateway processes are running concurrently,
   * because the atomicity is enforced by Postgres itself, not by
   * single-threaded JS execution order (which is what makes the SQLite
   * version in store.ts race-safe instead).
   */
  async claimAction(id: string): Promise<StoredActionLogEntry | undefined> {
    const result = await this.pool.query<any>(
      `UPDATE action_log SET result_status = 'deciding'
       WHERE id = $1 AND result_status = 'awaiting_approval'
       RETURNING id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at`,
      [id],
    );
    return result.rows[0] ? this.rowToAction(result.rows[0]) : undefined;
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

    const result = await this.pool.query<any>(
      `UPDATE action_log SET approved = $1, result_status = $2, detail = $3 WHERE id = $4
       RETURNING id, action, risk_level, approved, result_status, detail, tool_name, tool_input, run_id, created_at`,
      [approved, resultStatus, JSON.stringify(detail ?? {}), id],
    );
    return result.rows[0] ? this.rowToAction(result.rows[0]) : undefined;
  }

  async createAgentRun(input: AgentRunInput): Promise<StoredAgentRun> {
    const result = await this.pool.query<StoredAgentRun>(
      `INSERT INTO agent_runs (status, step_count, max_steps, max_delegation_depth)
       VALUES ('running', 0, $1, $2)
       RETURNING id, status, step_count, max_steps, max_delegation_depth, started_at, finished_at`,
      [input.maxSteps, input.maxDelegationDepth],
    );
    return result.rows[0];
  }

  async getAgentRun(id: string): Promise<StoredAgentRun | undefined> {
    const result = await this.pool.query<StoredAgentRun>(
      "SELECT id, status, step_count, max_steps, max_delegation_depth, started_at, finished_at FROM agent_runs WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  async setAgentRunStepCount(id: string, stepCount: number): Promise<StoredAgentRun | undefined> {
    const run = await this.getAgentRun(id);
    if (!run) return undefined;
    const status = stepCount >= run.max_steps ? "completed" : "running";
    const result = await this.pool.query<StoredAgentRun>(
      `UPDATE agent_runs SET step_count = $1, status = $2,
         finished_at = CASE WHEN $2 = 'completed' THEN now() ELSE finished_at END
       WHERE id = $3
       RETURNING id, status, step_count, max_steps, max_delegation_depth, started_at, finished_at`,
      [stepCount, status, id],
    );
    return result.rows[0];
  }

  async upsertSecret(
    name: string,
    payload: { ciphertext: string; iv: string; authTag: string },
  ): Promise<StoredSecretRow> {
    const result = await this.pool.query<any>(
      `INSERT INTO vault_secrets (name, ciphertext, iv, auth_tag, version)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (name) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         version = vault_secrets.version + 1,
         updated_at = now()
       RETURNING name, ciphertext, iv, auth_tag, version, created_at, updated_at`,
      [name, payload.ciphertext, payload.iv, payload.authTag],
    );
    return this.rowToSecret(result.rows[0]);
  }

  private rowToSecret(row: any): StoredSecretRow {
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

  async getSecretRow(name: string): Promise<StoredSecretRow | undefined> {
    const result = await this.pool.query<any>(
      "SELECT name, ciphertext, iv, auth_tag, version, created_at, updated_at FROM vault_secrets WHERE name = $1",
      [name],
    );
    return result.rows[0] ? this.rowToSecret(result.rows[0]) : undefined;
  }

  async deleteSecretRow(name: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM vault_secrets WHERE name = $1", [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async listSecretNames(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>("SELECT name FROM vault_secrets ORDER BY name ASC");
    return result.rows.map((r) => r.name);
  }
}
