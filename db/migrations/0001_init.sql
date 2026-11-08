-- AXORA Phase 1 schema. Written for PostgreSQL 15+. Not executed in this
-- sandbox (no Postgres server available) — review before running.
-- Run with: psql "$DATABASE_URL" -f db/migrations/0001_init.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  device_label TEXT
);

-- ---------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Conversations / messages
-- ---------------------------------------------------------------------
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT,
  is_temporary BOOLEAN NOT NULL DEFAULT false, -- incognito / temporary chat
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_conversations_project ON conversations(project_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  provider_id TEXT,          -- which ModelProvider produced this (assistant msgs)
  usage JSONB,                -- {input_tokens, output_tokens}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- ---------------------------------------------------------------------
-- Memory
-- ---------------------------------------------------------------------
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable until auth/session wiring lands in the gateway (currently
  -- PostgresStore.addMemory has no authenticated user to attach here).
  -- Tighten to NOT NULL once every write path threads a real user id.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  -- Scoping actually used today by the gateway (server.ts's
  -- assembleContext / listMemoriesForContext): a memory with
  -- conversation_id NULL is global; non-null scopes it to one
  -- conversation. project_id above is the intended longer-term scope
  -- once a real project system exists; conversation_id is what's wired
  -- up now.
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,     -- fact | preference | goal | instruction | relationship
  content TEXT NOT NULL,
  source TEXT NOT NULL,       -- chat | import | manual
  confidence REAL NOT NULL DEFAULT 1.0,
  importance REAL NOT NULL DEFAULT 0.5,
  embedding VECTOR(1536),     -- requires pgvector; nullable until embedded
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_memories_user ON memories(user_id);

-- ---------------------------------------------------------------------
-- Knowledge Vault (RAG)
-- ---------------------------------------------------------------------
CREATE TABLE knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable for the same reason as memories.user_id above — no auth
  -- wiring yet.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,  -- pdf | docx | md | url | ...
  status TEXT NOT NULL DEFAULT 'pending', -- pending|parsing|chunking|embedding|ready|failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_knowledge_chunks_document ON knowledge_chunks(document_id);

-- ---------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model_provider TEXT,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_steps INT NOT NULL DEFAULT 10,
  approval_policy TEXT NOT NULL DEFAULT 'ask', -- ask | auto_low_risk | never
  visibility TEXT NOT NULL DEFAULT 'private',  -- private | project | public
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Secret Vault (master spec section 26). Stores only the encrypted
-- payload — ciphertext, IV, and GCM auth tag — never plaintext. The
-- master encryption key (AXORA_SECRET_KEY) lives only in the gateway
-- process's environment, never in this database.
CREATE TABLE vault_secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable until agent definitions (the `agents` table above) are
  -- actually created through an API — today's gateway starts runs
  -- ad-hoc via POST /v1/agent-runs with no agent record behind them yet.
  -- Tighten to NOT NULL once agent creation exists.
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|queued|running|waiting_approval|completed|failed|cancelled
  step_count INT NOT NULL DEFAULT 0,
  max_steps INT NOT NULL DEFAULT 10,
  max_delegation_depth INT NOT NULL DEFAULT 3,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'one_time', -- one_time|scheduled|recurring|background
  schedule TEXT,               -- cron expression, if scheduled/recurring
  status TEXT NOT NULL DEFAULT 'pending',
  requires_permission BOOLEAN NOT NULL DEFAULT true, -- autonomous tasks need explicit grant
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Tools, permissions, action log
-- ---------------------------------------------------------------------
CREATE TABLE tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  schema JSONB NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'low', -- low|medium|high|dangerous
  requires_auth BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  tool_id UUID REFERENCES tools(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  risk_level TEXT,
  approved BOOLEAN,
  result_status TEXT NOT NULL DEFAULT 'pending', -- pending|success|failed|denied|awaiting_approval
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Resumability: what to re-run and against which budget once a human
  -- approves an `awaiting_approval` entry (see POST /v1/action-log/:id/decision).
  tool_name TEXT,
  tool_input TEXT,
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_action_log_user ON action_log(user_id, created_at);

COMMIT;
