# Verification log (Phase 1)

Honest record of what was actually executed in the sandbox that produced
this repo, so nothing in `README.md` is taken on faith.

## Environment constraints observed

- No network egress (`registry.npmjs.org` blocked by the sandbox's egress
  allowlist) — `npm install` / `cargo build` (crates.io) not possible here.
- No `rustc`/`cargo` installed.
- No PostgreSQL server running.
- Node.js v22.22.2, `tsc` 6.0.3 and Playwright were available globally.

Given that, the gateway was deliberately written with **zero runtime npm
dependencies** so it could be compiled and run for real, and the browser
client was tested for real with the Playwright browser that happened to be
preinstalled.

## What was actually run

1. `tsc -p services/gateway` — compiled `src/*.ts` to `dist/*.js`.
   (14 type errors reported, all `Cannot find name 'process'/'Buffer'/
   'console'/'node:...'` — these are exactly the errors you get without
   `@types/node` installed, not logic errors. `tsc` still emits JS in that
   case, and the emitted JS is what was executed below.)
2. `node --experimental-sqlite dist/server.js` — booted the gateway on
   port 8787, using the built-in SQLite dev store.
3. `curl /v1/health` → returned the registered provider list (`mock`).
4. `curl -X POST /v1/chat/completions` with a real user message → received
   a real Server-Sent-Events stream of ~37 incremental `delta` chunks
   followed by a `done:true` chunk with token usage, produced by
   `MockProvider.stream()` actually iterating and yielding — not a
   canned static response.
5. `curl /v1/conversations` → returned the conversation created by step 4,
   proving the SQLite store actually persisted it.
6. Playwright (`chromium.launch()`) loaded `apps/web/public/index.html`
   from `file://`, typed a message into the real UI, clicked send, and
   the assistant bubble filled in with the streamed response from the
   live gateway.
   - **First attempt failed**: `[error] Failed to fetch` — the gateway had
     no CORS/OPTIONS handling, so the cross-origin `fetch` from the
     `file://` page was blocked by the browser. This is a real bug found
     by the test, not a hypothetical one.
   - Fixed in `src/server.ts` (`applyCors`, `OPTIONS` handling),
     recompiled, reran the same Playwright script — passed, with the
     assistant bubble showing the actual streamed mock-provider text.

## What was NOT run (and why)

- `db/migrations/0001_init.sql` — no Postgres server in this sandbox.
  Written, reviewed, not executed. Run it yourself with
  `docker compose up` and `psql`.
- `services/core` (Rust) — no `rustc`/`cargo` in this sandbox. Zero
  external crates so it has the best chance of compiling unmodified;
  `cargo test` should run `policy.rs`'s unit tests once you have a
  toolchain. Unverified here.
- `docker compose up` itself — Docker is not available in this sandbox.
  The Dockerfile and compose file are written and reviewed, not executed.
- Next.js production frontend — not started; only the static/no-build
  `apps/web/public/index.html` dev client was built and verified.

---

## Milestone 2: PostgresStore, memory retrieval, Anthropic provider, Rust agent runtime

Same sandbox, same constraints (no network, no `rustc`, no Postgres, no
Docker) — re-confirmed at the start of this session (`rustc`/`cargo`
still absent, `registry.npmjs.org` still blocked).

### What was actually run

1. `tsc -p services/gateway` after adding `memory/retrieval.ts`,
   `postgresStore.ts`, `providers/anthropicProvider.ts`,
   `providers/anthropicSse.ts`, and the memory/context-assembly wiring in
   `server.ts`. Caught and fixed two real bugs this way, not the usual
   missing-`@types/node` noise:
   - `memory/retrieval.ts` imported `./types.js` instead of `../types.js`
     (wrong relative path from the new `memory/` subdirectory) — the
     module simply wouldn't have resolved at runtime. Fixed.
   - `postgresStore.ts` tried to insert a memory with `user_id = null`
     against a schema column that was `NOT NULL` — would have failed at
     the database on the very first write. Fixed by relaxing that column
     (documented in the migration as pending real auth wiring) rather
     than papering over it with a fake user id.
2. `node --test` on the new unit suites:
   - `memory/retrieval.test.ts` — 8 tests.
   - `providers/anthropicSse.test.ts` — 6 tests.
   - **14/14 passed** after fixing a genuinely wrong test expectation
     (`tokenize("AXORA's ...")` — the test originally asserted the
     trailing "s" survives tokenization; it doesn't, by design, since
     single-character tokens are filtered — the test was wrong, not the
     code; fixed the test).
3. Booted the compiled gateway (`node --experimental-sqlite dist/server.js`)
   and, over real HTTP:
   - `POST /v1/memories` then `GET /v1/memories` — round-tripped two
     stored memories through SQLite.
   - `POST /v1/chat/completions` with a query worded differently from a
     stored memory ("what theme do I prefer?" vs. stored "the user
     **prefers** dark mode...") — **first attempt returned zero relevant
     memories**, a real gap (no stemming, so "prefer" ≠ "prefers").
     Fixed by adding a small conservative stemmer to
     `memory/retrieval.ts`, added a regression test for exactly this
     case, reran the unit suite (still 14/14, now including the
     regression test), then reran the same live HTTP call — confirmed
     via a `context_assembly` log line that the memory was now found
     (relevance score 0.63) and would be injected into the provider
     context.
   - `GET /v1/health` with `ANTHROPIC_API_KEY` set to a fake value —
     confirmed the provider registration/dynamic-import wiring works and
     both `mock` and `anthropic` show up in the provider list. This
     verifies the *wiring*, not a real model call (see below).
4. Reran the existing Playwright browser end-to-end test against the
   updated server as a regression check — still passes.

### What was NOT run (and why)

- `PostgresStore` — no Postgres server, no network to `npm install pg`.
  Type-checked against a hand-written ambient declaration
  (`src/types/pg.d.ts`); the SQL itself was manually reviewed against
  `0001_init.sql` but never executed against a real database.
- `AnthropicProvider`'s actual `fetch()` call to `api.anthropic.com` —
  no network egress. What *was* verified: (a) the SSE parsing logic it
  depends on, via 6 unit tests against a hand-written canned payload,
  and (b) that it gets correctly registered and selected by the router
  when an API key is present. The HTTP call itself is unverified.
- `services/core` Rust changes (`tools.rs`, `agent.rs`, rewritten
  `main.rs`) — still no `rustc` in this sandbox. Reviewed by hand for
  the kind of thing a compiler catches (e.g. an import of `RiskLevel`
  from the wrong module was caught this way and fixed before it could
  have become a real `cargo build` failure) but not compiled.

---

## Milestone 3: Knowledge Vault (parse/clean/chunk + retrieval, wired into context)

Same sandbox, same constraints, re-confirmed unchanged at the start of
this session.

### What was actually run

1. `tsc -p services/gateway` after adding `knowledge/chunking.ts`,
   `knowledge/retrieval.ts`, Store methods (`ingestDocument`,
   `listDocuments`, `listChunksWithTitles`) in both `SqliteStore` and
   `PostgresStore`, and two new HTTP endpoints. Also refactored
   `memory/retrieval.ts` to expose a reusable `overlapScore` primitive
   so knowledge-chunk retrieval doesn't duplicate the scoring logic —
   reran the full existing suite immediately after that refactor
   specifically to catch any regression it might have introduced.
2. `node --test` on the new suites:
   - `knowledge/chunking.test.ts` — 9 tests, **all passed on the first
     run** (paragraph packing, overlap, hard-splitting an oversized
     paragraph, empty input, sequential indices, the
     overlap-must-be-smaller-than-maxChars guard).
   - `knowledge/retrieval.test.ts` — 4 tests, passed.
   - Full suite after the `overlapScore` refactor: **27/27 passed**
     (14 memory/SSE from Milestone 2 + 9 chunking + 4 knowledge
     retrieval).
3. Live HTTP, real chunking + retrieval + context injection, no mocks:
   - `POST /v1/knowledge/documents` with a 3-paragraph document about
     the Model Router → returned `status: "ready"`.
   - `GET /v1/knowledge/documents` → listed it.
   - `POST /v1/chat/completions` asking "how does the model router pick
     a provider when none is specified?" (phrased differently from the
     source text, not copy-pasted) → the `context_assembly` log line
     showed `total_chunks: 1`, `relevant_chunks: [{"score": 0.667}]`,
     and the request's `input_tokens` rose from the baseline ~5 to 86,
     confirming the retrieved chunk was actually injected into what the
     provider received.
4. Regression pass: reran the Playwright browser end-to-end test and the
   Milestone-2 memory-retrieval live test in the same server process as
   the new knowledge endpoints — both still passed
   (`relevant_memories: [{"score": 0.63}]` for the "what theme do I
   prefer?" case), confirming memory and knowledge retrieval coexist
   correctly in `assembleContext`.

### What was NOT run (and why)

- Real document parsers (PDF, DOCX, HTML, etc.) — not built yet.
  `ingestDocument` takes already-extracted plain text; this milestone
  only covers clean/chunk/retrieve, not format parsing.
- Embedding-based retrieval — still no reachable embeddings API from
  this sandbox; `knowledge/retrieval.ts`'s docstring states this
  limitation explicitly rather than silently shipping fake vectors.
- `PostgresStore`'s new methods (`ingestDocument`, `listDocuments`,
  `listChunksWithTitles`) — same as Milestone 2's PostgresStore: no
  Postgres server here. SQL reviewed by hand against the schema, not
  executed.

---

## Milestone 4: Tool System + Policy Engine + Agent Runner (TypeScript, running in the gateway) + Action Log

Same sandbox, same constraints, re-confirmed unchanged at the start of
this session (`rustc`/`cargo` still absent).

### Why TypeScript, not just Rust

`services/core`'s Rust policy/tools/agent modules from Milestone 1 are
still unverified (no `rustc`). Since real tool calls flow through the
gateway today and there is no cross-process boundary to a Rust binary
that isn't even compiled, the enforcement logic needed to actually exist
and run *somewhere reachable* — so it was reimplemented in TypeScript
(`services/gateway/src/core/{policy,tools,agent}.ts`), deliberately
behaviorally identical to the Rust version (same test cases translated
directly), and wired into the gateway for real. The Rust version remains
the intended long-term home per the master spec.

### What was actually run

1. `tsc -p services/gateway` after adding `core/policy.ts`, `core/tools.ts`,
   `core/agent.ts`, their test files, `action_log` support in both
   `SqliteStore` and `PostgresStore`, and three new HTTP endpoints
   (`POST /v1/tools/execute`, `GET /v1/tools`, `GET /v1/action-log`) —
   no real type errors (only the usual missing-`@types/node` noise).
2. `node --test` — ran standalone first (10/10 passed: dangerous-always-
   requires-approval-even-under-never-policy, exhausted-budget-denies,
   low-risk-auto-allowed, high-risk-requires-approval, ask-policy-always-
   asks, delegation-depth-exceeded-denies, executes-low-risk,
   unknown-tool-reported, dangerous-step-halts-and-never-executes,
   run-plan-stops-at-step-limit), then reran as part of the **full
   6-suite, 37-test regression** after wiring into `server.ts` — still
   37/37.
3. Live HTTP, no mocks:
   - `GET /v1/tools` → listed all three registered tools with correct
     risk levels.
   - `POST /v1/tools/execute` with `echo` and `get_current_time` (both
     low-risk) → both returned `{"type":"executed", ...}` with real
     output (an actual current-time string for the latter).
   - `POST /v1/tools/execute` with `delete_everything` (dangerous) →
     returned `{"type":"awaiting_approval", ...}` — **confirmed it did
     not execute**: the tool's own `execute()` method contains a
     canary string ("!! THIS SHOULD NEVER EXECUTE...") that never
     appeared anywhere in the response or logs.
   - `POST /v1/tools/execute` with an unregistered tool name → returned
     `{"type":"unknown_tool", ...}` rather than crashing or silently
     no-op'ing.
   - `GET /v1/action-log` → all four calls above were present, each with
     the correct `resultStatus` (`success`/`success`/`awaiting_approval`/
     `failed`) and `approved` flag (`true`/`true`/`null`/`null`).
4. Full regression in the same server process as the new endpoints:
   Playwright browser e2e (still passes), memory retrieval
   ("what theme do I prefer?" → score 0.63), knowledge vault retrieval
   ("how does the model router pick a provider?" → score 0.75) — all
   via `context_assembly` log lines with zero errors in the server log.

### What was NOT run (and why)

- The Rust `services/core` equivalent of this same milestone
  (`tools.rs`, `agent.rs`) — still no `rustc` in this sandbox. It exists
  from Milestone 1, reviewed by hand, not compiled.
- Any real approval UI — `awaiting_approval` outcomes are correctly
  produced and logged, but nothing yet lets a human actually grant the
  approval and resume execution. That's the literal next thing to build.
- Per-run (vs. shared/global) `RunLimits` — the gateway's `runLimits` is
  one process-wide budget today, documented as a known simplification in
  both `server.ts` and `README.md`, not hidden.

---

## Milestone 5: Approval-resume flow + per-run step budgets

Same sandbox, same constraints, re-confirmed unchanged.

### What was actually run

1. `tsc -p services/gateway` after adding `agent_runs` support (Store
   interface + SqliteStore + PostgresStore), resumability fields on
   `action_log` (`tool_name`, `tool_input`, `run_id`), and three new
   endpoints: `POST /v1/agent-runs`, `GET /v1/agent-runs/:id`,
   `POST /v1/action-log/:id/decision`, plus `run_id` support in the
   existing `POST /v1/tools/execute`. No real type errors.
2. Full existing 37-test suite reran as a pre-flight regression check
   before live-testing the new behavior — still 37/37.
3. Live HTTP, no mocks, two separate scenarios:
   - **Per-run budget**: created a run with `max_steps: 2`. First and
     second `echo` calls scoped to that `run_id` both executed and
     `GET /v1/agent-runs/:id` showed `step_count` incrementing 0→1→2 and
     `status` flipping to `"completed"` exactly at the limit. A third
     call against the same run was rejected with
     `409 agent_run_already_completed` — **confirmed it did not
     silently execute past budget**.
   - **Approval resume**: triggered `delete_everything` (dangerous) to
     get an `awaiting_approval` action log entry, looked its id up via
     `GET /v1/action-log`, then:
     - `{"approved": false}` → entry became `resultStatus: "denied"`,
       tool never ran.
     - A second `delete_everything` call, this time
       `{"approved": true}` → entry became `resultStatus: "success"`
       and its `detail.output` contained the tool's own canary string
       ("!! THIS SHOULD NEVER EXECUTE WITHOUT APPROVAL !!") —
       confirming the tool genuinely executed at approval time, not
       before and not as a fabricated success.
     - A second decision on that same now-resolved action correctly
       returned `409 action_not_awaiting_approval` rather than
       re-executing or silently succeeding.
4. Full regression in the same server process: Playwright browser e2e,
   memory retrieval (score 0.63), knowledge vault retrieval (score
   0.667), and a plain tool execution — all via the same run, zero
   errors in the server log.

### What was NOT run (and why)

- `PostgresStore`'s new methods (`createAgentRun`, `getAgentRun`,
  `setAgentRunStepCount`, updated `logAction`/`getAction`/`updateAction`)
  — no Postgres server in this sandbox, same as every other
  `PostgresStore` method. SQL reviewed by hand against the updated
  schema (`agent_runs.agent_id` relaxed to nullable, `action_log` gained
  three columns and an FK to `agent_runs`), not executed.
- Concurrent/racing decisions on the same action (two approvals arriving
  at once) — not tested; the current implementation has no explicit
  locking around the read-then-update in `handleActionDecision`, which
  is a real gap worth flagging rather than a verified-safe property.

---

## Milestone 6: Real document parsers (PDF/HTML/CSV/JSON/text) + upload endpoint

Same sandbox; `rustc`/`cargo`/network still absent, re-confirmed at the
start of this session. One thing changed: `pdfjs-dist` and `pdf-lib`
turned out to already be globally preinstalled in this sandbox (used
elsewhere for document-skill tooling), which made genuine end-to-end PDF
verification possible for the first time — see the `node_modules` note
in README for exactly how they were made resolvable here and why that
doesn't affect anyone running this repo for real.

### What was actually run

1. A standalone probe script *before* writing any gateway code: generated
   a PDF with `pdf-lib`, extracted its text with `pdfjs-dist`'s legacy
   Node build. Confirmed the approach works before investing in the
   gateway integration — this is why the PDF pipeline could be built
   with real confidence rather than hopeful review.
2. `tsc -p services/gateway` after adding
   `knowledge/parsers/{types,textParser,htmlParser,csvParser,jsonParser,pdfParser,registry}.ts`
   and their test files. One real bug caught and fixed: `import.meta.url`
   in `pdfParser.test.ts` didn't typecheck under this sandbox's
   incomplete `@types/node` situation — worked around with a documented
   cast rather than silently suppressing the error.
3. `node --test` on the new suites:
   - `htmlParser.test.ts` — 4 tests (tag stripping, script/style removal,
     entity decoding, end-to-end).
   - `csvParser.test.ts` — 5 tests (unquoted, quoted-with-commas/newlines,
     escaped quotes, readable-text rendering, end-to-end).
   - `jsonParser.test.ts` — 5 tests (flat, nested, arrays, array-of-objects,
     end-to-end).
   - `pdfParser.test.ts` — **2 tests, genuinely end-to-end**: built real
     PDFs with `pdf-lib` (single-page and multi-page), extracted their
     text with the actual `pdfParser` module, asserted the extracted text
     matches what was written into the PDF. This is real PDF parsing
     verified against real PDF bytes, not a hand-written fixture string.
   - Full regression: **53/53** across all 10 suites.
4. Live HTTP, no mocks, through the new `POST /v1/knowledge/documents/upload`:
   - A real PDF (base64-encoded) → `status: "ready"`, `extractedChars: 35`.
   - A real CSV → parsed into `"column: value"` text.
   - Real HTML with an entity (`&amp;`) → tags stripped, entity decoded.
   - An unsupported type (`docx`) → `400 unsupported_source_type` with
     the actual list of supported types, not a silent failure.
   - Asked a question worded differently from the uploaded PDF's text
     ("what does the ingestion pipeline test say?" vs. the PDF's "AXORA
     ingestion pipeline live test.") → `context_assembly` log confirmed
     the PDF-derived chunk was found and retrieved (score 0.75).
5. Regression: reran the Playwright browser e2e test in the same server
   process — still passes, zero errors logged.

### What was NOT run (and why)

- DOCX, PPTX, XLSX, image/OCR, audio/video parsing — not built. The
  spec's full Knowledge Vault format list (section 13) is larger than
  PDF/HTML/CSV/JSON/text; those five were chosen because they're
  buildable and verifiable without network access, not because they're
  the whole list.
- `npm install` of `pg`/`pdfjs-dist`/`pdf-lib` from the real registry —
  still impossible here (no network). What stands in for it in this
  sandbox is documented plainly in README so it's never mistaken for a
  real install.

---

## Milestone 7: Concurrent-decision race fix + conversation-scoped memory/knowledge

Same sandbox, same constraints, re-confirmed unchanged at the start of
this session. Closes the two gaps explicitly flagged at the end of
Milestone 6.

### Concurrent-decision race — what was actually run

1. Added `Store.claimAction` (atomic `UPDATE ... WHERE result_status =
   'awaiting_approval'`) to both `SqliteStore` and `PostgresStore`, and
   rewired `handleActionDecision` to call it instead of the old
   read-then-later-write pattern.
2. `tsc -p services/gateway` — no real type errors.
3. `node --test` on a new suite, `core/claimAction.test.ts` — 3 tests,
   including one that genuinely races two concurrent attempts against
   the same action (via `Promise.all` with a real `await` gap simulating
   `tool.execute()` in between claim and finalize) and asserts exactly
   one wins. All 3 passed. Full regression: **56/56** across all 11
   suites.
4. **Live HTTP, real concurrency, not simulated**: triggered a dangerous
   action to get an `awaiting_approval` entry, then backgrounded two
   real `curl` processes hitting `POST /v1/action-log/:id/decision`
   with `{"approved": true}` at the same time and `wait`ed on both.
   Result: one got `200` with `resultStatus: "success"` and the tool's
   canary output; the other got `409 action_not_awaiting_approval`.
   This is the strongest verification in this repo so far — an actual
   OS-level race between two real HTTP connections, not just two
   `Promise.all`'d function calls in the same process.
5. Regression: browser e2e still passes, zero errors.

### Conversation-scoped memory/knowledge — what was actually run

1. Added `conversationId` to `MemoryInput`/`KnowledgeDocumentInput`
   (nullable = global, the original behavior, still supported),
   `Store.listMemoriesForContext`/`listChunksForContext` (global ∪
   this-conversation's-own), wired into `assembleContext`. Updated the
   Postgres schema: `memories.conversation_id` and
   `knowledge_documents.conversation_id`, both nullable FKs to
   `conversations(id)`; also relaxed `knowledge_documents.user_id` to
   nullable (same reasoning as `memories.user_id` in Milestone 2 — no
   auth wiring yet, would have failed on the first real insert
   otherwise, caught by reading the schema against the store code before
   writing the migration, not by a failed write).
2. `tsc -p services/gateway` — no real type errors after updating the
   `mem()` test helper in `memory/retrieval.test.ts` to include the new
   required `conversation_id` field.
3. Full regression: **56/56** unchanged — scoping only changes which
   rows `assembleContext` sees, not how `retrieveMemories`/
   `retrieveChunks` score them, so none of the existing retrieval tests
   needed to change.
4. **Live HTTP, the actual isolation property, not just the plumbing**:
   added a memory scoped to `conversationId: "conv-A"` and a second,
   global memory (no `conversationId`). Asked the same question ("what
   theme do I prefer?") in conversation A and conversation B:
   - Conversation A: `scoped_memories: 2` (its own + global),
     `relevant_memories` found the private one (score 0.63).
   - Conversation B: `scoped_memories: 1` (global only),
     `relevant_memories: []` — **A's private memory was genuinely
     invisible**, not just unscored.
   - A different question in conversation B, about the global fact,
     correctly found it (score 0.98) — confirming global memories still
     work everywhere, isolation isn't over-scoping either.
5. Regression: browser e2e and a plain-text knowledge-vault document
   ingested with no `conversationId` (global) were both still retrieved
   correctly in an unrelated conversation, confirming the default
   (unscoped) path is unchanged for anyone not using the new field.

### What was NOT run (and why)

- `PostgresStore`'s updated `addMemory`/`listMemoriesForContext`/
  `ingestDocument`/`listChunksForContext` and the migration's new
  columns — no Postgres server here, same as every other `PostgresStore`
  method this whole project. SQL reviewed by hand, not executed.
- User- and project-level scoping — conversation-level was the specific
  gap flagged and closed this milestone; broader multi-tenancy still
  needs the auth/project system that doesn't exist yet (see README
  "Next implementation steps").

---

## Milestone 8: DOCX/PPTX/XLSX parsing (from-scratch ZIP reader) + per-run budgets as the only path

Same sandbox, same constraints (no `rustc`/`cargo`/network), re-confirmed
unchanged. Closes both gaps explicitly flagged at the end of Milestone 7.

### DOCX/PPTX/XLSX — what was actually run

1. Confirmed no zip library (`jszip`, `adm-zip`, `yauzl`, ...) is
   installed or installable (no network) before deciding to write a ZIP
   reader from scratch against the actual format spec, using only
   Node's built-in `zlib` (`inflateRawSync` for DEFLATE, `crc32` for
   test-fixture generation) — both confirmed present in this Node 22
   build before writing a line of parser code.
2. `zip/miniZip.ts` (reader) + `zip/testFixtureZipWriter.ts` (test-only
   writer, stored/uncompressed entries) + `zip/miniZip.test.ts` — 5
   tests, including one that hand-builds a ZIP entry with real
   DEFLATE-compressed data (via `zlib.deflateRawSync`, independently of
   the test-fixture writer) and confirms `miniZip.ts` decompresses it
   correctly — proving the actual compression codepath, not just the
   stored/passthrough one. All 5 passed on the first run.
3. `docxParser.ts` (extracts `word/document.xml`, joins multi-run
   paragraphs, separates paragraphs with blank lines to match
   `chunking.ts`'s expectations) — 6 tests including a fixture with a
   paragraph split across three `<w:t>` runs (the way real Word output
   looks when bold formatting starts mid-sentence) and an XML entity
   (`&amp;`). All passed.
4. `pptxParser.ts` (extracts `ppt/slides/slideN.xml`, sorted by parsed
   slide number) — 5 tests including one that deliberately inserts
   slide10 before slide1/slide2 in the ZIP to prove numeric sort order
   is used, not ZIP entry order. All passed.
5. `xlsxParser.ts` (resolves `xl/sharedStrings.xml` references, reads
   `xl/worksheets/sheet1.xml`, sorts sparse cells by column letter) — 6
   tests including shared-string resolution, direct numeric cells, and
   out-of-order sparse cells (C1 before A1 in the XML, with B1 absent).
   All passed.
6. Full regression: **78/78** across all 15 suites.
7. **Live HTTP, real fixtures, no mocks**: built a real DOCX (two
   paragraphs), a real PPTX (one slide), and a real XLSX (shared-string
   header + numeric cell) using the test fixture writer, base64-encoded
   each, and uploaded all three through `POST
   /v1/knowledge/documents/upload` — all three returned `status:
   "ready"` with correct `extractedChars` counts. Asked a question
   worded differently from the DOCX's actual text ("does the knowledge
   vault read Word documents now?" vs. the DOCX's "The knowledge vault
   now reads real Word documents.") — `context_assembly` log confirmed
   the DOCX-derived chunk was retrieved with a perfect relevance score
   of 1.0.
8. Regression: browser e2e still passes, zero errors.

### Per-run budgets as the only path — what was actually run

1. Removed the process-wide `runLimits`/`agentRunner` globals entirely.
   `handleExecuteTool` now always resolves a real `agent_runs` row —
   either the one named by `run_id`, or a freshly created one (defaults:
   50 steps, delegation depth 5) when the caller omits it — and always
   returns `run_id` in the response.
2. `tsc` — no real type errors. Full regression: still 78/78 (no test
   needed new assertions here since the existing per-run-budget tests
   from Milestone 5 already covered the mechanism; what changed is that
   there's no other path left to fall back to).
3. **Live HTTP**: called `/v1/tools/execute` twice with no `run_id` at
   all — got back two different `run_id`s, each independently a real
   row in `agent_runs` with its own `step_count`. Fetched the first run
   via `GET /v1/agent-runs/:id` and confirmed `step_count: 1,
   max_steps: 50` — a genuine persisted budget, not a fabricated one.
   Separately confirmed the existing reuse path still works: passing a
   previously-returned `run_id` on a second call correctly incremented
   that same run's `step_count` to 2.
4. Regression: browser e2e and memory retrieval both still pass, zero
   errors.

### What was NOT run (and why)

- Real Office documents produced by actual Word/PowerPoint/Excel (as
  opposed to hand-built minimal fixtures matching the same ZIP+XML
  shape) — not tested. Real files from those applications include a lot
  more XML (styles, theme, relationships, etc.) that these parsers
  ignore by design, but a real file could in principle use XML
  constructs (unusual namespacing, compatibility-mode markup) these
  regexes don't anticipate. The fixtures here are deliberately realistic
  (multi-run paragraphs, out-of-order slides, shared strings) but are
  still hand-built, not sourced from real Word/PowerPoint/Excel output.
- `PostgresStore` — unaffected by either change in this milestone, but
  still generally unverified for the reason given in every prior
  milestone: no Postgres server in this sandbox.

---

## Milestone 9: Rust manual audit + background Task Engine (TaskQueue)

Same sandbox; `rustc`/`cargo`/network reconfirmed absent at the start of
this session (checked `rustc --version`, `cargo --version`, `rustup`,
and a network probe to `static.rust-lang.org` — all unavailable, same as
every prior milestone).

### Rust manual audit — what was actually done

Since `services/core` still can't be compiled, this was a deliberately
more rigorous review than "read it and it looks fine": a line-by-line
trace of `agent.rs`'s borrow-checker semantics specifically, because
that's the file most likely to hide a real lifetime conflict (it holds
both a `&'a ToolRegistry` and a `&mut self.limits` and calls methods on
both within the same function).

What was actually traced through, in Rust's real semantics (not
approximated):
- Why `self.registry.get(...)` returns a reference tied to lifetime
  `'a` (the stored `&'a ToolRegistry` field) rather than to `&self`'s
  borrow of the `AgentRunner` — confirmed via lifetime elision rule 2
  (output lifetime takes the `&self` receiver's lifetime) applied to
  `ToolRegistry::get(&self, ...)`, combined with reference fields being
  `Copy` (so reading `self.registry` is a cheap copy-out, not a borrow
  that outlives the field access).
- Why `self.limits.record_step()` (a `&mut` borrow) doesn't conflict
  with the earlier `&self.limits` passed into `policy.evaluate(...)` —
  traced via non-lexical lifetimes: `evaluate` returns an owned
  `PolicyDecision` and the borrow's last use is the call itself, so it
  has already ended by the time `record_step()` runs.
- Why `tool.execute(...)` (using the `'a`-lifetime reference obtained
  earlier) remains valid even after the intervening mutable borrow of
  `self.limits` — because `tool`'s lifetime was never tied to `self` in
  the first place, only to the registry.
- `policy.rs` and `tools.rs`: re-read for the categories of bug that
  keep turning up on the TypeScript side of this project (wrong
  imports, off-by-one comparisons, missing trait bounds needed for
  `assert_eq!`'s `Debug`/`PartialEq` requirements) — none found.
- `main.rs`: confirmed the borrow timeline of `registry.register(...)`
  (two mutable borrows, each ending at its own statement) followed by
  `&registry` (immutable, starting fresh) doesn't conflict, and that
  `run_plan`'s returned `Vec<StepOutcome>` is fully owned (no
  fields borrow from `self`), so iterating it after the method call
  raises no further borrow issue.

Result: no bugs found. One legitimate, low-risk improvement applied
without needing a compiler to justify it: `impl Default for
ToolRegistry` (the standard companion to a no-arg `new()` —
`clippy::new_without_default`), plus a test for it. This is explicitly
**not equivalent to `cargo build`/`cargo test`** — a real toolchain could
still catch something this review didn't (a stdlib API difference across
versions, a feature-stability edge case). Confidence is higher than
before, not certainty.

### TaskQueue — what was actually run

1. `core/taskQueue.ts` + `core/taskQueue.test.ts` — 7 tests written
   before wiring it into anything else, specifically to catch design
   bugs early.
2. **First run: 2 of 7 failed**, and it was a real bug, not a bad test:
   `enqueue()` called `drain()` (which starts task execution)
   synchronously, so a task with no `await` before its first side effect
   ran its synchronous prefix *inside* the `enqueue()` call itself —
   defeating the actual point of a background queue (a caller needs to
   be able to return a "pending" response before any task work starts).
   Fixed by deferring `drain()` via `queueMicrotask`. Recompiled, reran:
   **7/7 passed**, including a genuine concurrency test (holds 5 tasks
   open on controllable gates, asserts exactly `concurrency` (2) run
   simultaneously via an observed-max counter, then releases and
   confirms all 5 eventually complete) and a failure-isolation test (one
   task throwing doesn't block a second task from completing).
3. Split `Store.ingestDocument` into `createPendingDocument` (fast,
   synchronous, returns immediately with `status: "pending"`) and
   `chunkAndFinalizeDocument` (the actual chunking work, now run via
   `TaskQueue.enqueue`) in both `SqliteStore` and `PostgresStore`; added
   `Store.getDocument` and a new `GET /v1/knowledge/documents/:id`
   endpoint for polling. `ingestDocument` itself still exists as a
   synchronous convenience wrapper composing the two — nothing that
   called it directly needed to change.
4. `tsc -p services/gateway` — no real type errors (one more
   missing-`@types/node` entry, `queueMicrotask`, added to the filtered
   noise list — confirmed it's a real Node global via `node -e
   "console.log(typeof queueMicrotask)"` before dismissing the error as
   noise rather than assuming).
5. Full regression: **85/85** across all 16 suites.
6. **Live HTTP**: ingested a document — the response came back with
   `status: "pending"` (proving the request genuinely returns before
   chunking runs, not just in theory), then `GET
   /v1/knowledge/documents/:id` showed `status: "ready"` on the very
   next poll. Honest caveat: because the test document was tiny and the
   queue processes it in well under a network round-trip, this
   confirms the *contract* (pending on creation, ready shortly after)
   rather than having actually observed an intermediate "chunking"
   state in the wild — a larger document would show that state for
   longer, but nothing this size was tested. A request for a
   nonexistent document id correctly returned `404`. Asked a question
   about the newly-ingested content afterward — retrieved correctly
   (score 0.8).
7. Regression: browser e2e still passes, zero errors.

### What was NOT run (and why)

- `services/core` — still not compiled, for the reason stated at the
  top of this milestone. The manual audit above is the most that could
  be done without a toolchain.
- A real distributed task queue (Redis-backed, or similar) — `TaskQueue`
  is explicitly documented (in its own file) as the correct in-process
  stepping-stone, not a claim of having built real distributed
  infrastructure this sandbox has no way to stand up or test against.
- Chunking failure mid-queue (e.g. `chunkText` producing zero chunks)
  surfacing correctly as a `"failed"` document status via the actual
  queue path — **verified**: ingested a whitespace-only document (passes
  the `content` presence check but cleans/chunks to zero), polled after
  the queue processed it, confirmed `status: "failed"` with no server
  errors logged (a failed document is a legitimate outcome, not a crash).

---

## Milestone 10: Gateway ↔ Core integration boundary (`docs/CORE_PROTOCOL.md`)

Same sandbox; `rustc`/`cargo`/network reconfirmed absent at the start of
this session (same checks as every prior milestone — all unavailable).

This closes the gap flagged at the end of Milestone 9: `services/core`
(Rust) and `services/gateway/src/core` (TypeScript) were two
disconnected implementations of the same policy/tool/agent design, with
no actual communication path between them.

### Design decision

A real Rust toolchain still isn't available, so the Rust side of this
(`rpc.rs`) remains unverified no matter how it's built — but the
TypeScript *client* side absolutely can be genuinely tested, against a
real second OS process standing in for the not-yet-compilable
`axora-core` binary. The protocol (`docs/CORE_PROTOCOL.md`) is
newline-delimited JSON over a child process's stdin/stdout, matched by
request `id` (not order) specifically so this is testable: a mock
process can deliberately respond out of order to prove the client
doesn't assume FIFO ordering.

### What was actually run

1. `docs/CORE_PROTOCOL.md` written first, as the contract both sides
   implement against — including an explicit "client behavior contract"
   section (never hang forever, never fabricate a response, match by id
   under concurrency) that the tests below check item-by-item.
2. `coreClient.ts` (the gateway-side client) + a TEST-ONLY mock Core
   process (`testFixtures/mockCoreProcess.js`, a real standalone Node
   script with five modes: normal, delay-N, crash, garbage, outoforder)
   + `coreClient.test.ts` — 8 tests.
3. **First test run hung and had to be killed (300s timeout)** — a real
   bug, found exactly the way every other bug in this project has been:
   by actually running the tests rather than trusting the code. Root
   cause: when `start()`'s initial `ping` request failed (crash/garbage
   modes), the spawned child process was never killed, leaving a live
   subprocess with open stdio pipes that kept `node --test` from ever
   exiting — the test runner wasn't hung on logic, it was hung waiting
   for a leaked process. Fixed by killing the child on a failed
   `start()` (`CoreClient.forceKill()`). Reran with a 60s hard timeout
   as a safety net: **8/8 passed**, process exited cleanly, confirmed via
   `ps -ef` that no mock processes were left running afterward.
4. Tests cover: happy-path `ping`/`policy.evaluate` round-trips against
   a real subprocess; decision correctness (low-risk allow, dangerous
   always requires approval, exhausted budget denies with a reason) —
   computed by the mock's own independent reimplementation of the
   policy rules, not a passthrough, so this is a genuine cross-check,
   not just protocol plumbing; **concurrent requests matched correctly
   by id when the subprocess deliberately answers out of order**; a
   request that never gets a response times out cleanly rather than
   hanging; a crashed subprocess fails `start()` rather than pretending
   to be ready; a subprocess that only ever sends garbage is correctly
   never treated as successfully started.
5. Full regression after adding `coreClient.ts`/`.test.ts`: **93/93**
   across all 17 suites.
6. **Wired into the live request path** (the part that makes this a
   real integration, not just a standalone tested client): added a
   `PolicyProvider` interface to `policy.ts`, changed `AgentRunner` to
   depend on it instead of the concrete `PolicyEngine`, added
   `CorePolicyProvider` (adapts `CoreClient` to that interface), and
   `selectPolicyProvider()` in `server.ts` — called at startup, uses
   `CorePolicyProvider` when `AXORA_CORE_BIN` is set and the process
   starts successfully, falls back to the local `PolicyEngine` and logs
   clearly otherwise. Full regression after this wiring: still 93/93 (no
   existing test's behavior changed — `PolicyEngine` satisfies the new
   interface unchanged).
7. **Live HTTP, genuinely end-to-end, no mocks at the HTTP layer**:
   started the real gateway with `AXORA_CORE_BIN` pointed at the mock
   Core process (via a tiny shell wrapper so it's invoked exactly the
   way a real compiled binary would be — `<binary> serve`). Confirmed
   via the startup log that `policy_provider_selected` showed
   `"core_subprocess"`. Then:
   - `POST /v1/tools/execute` with `echo` (low risk) → `"executed"` —
     this decision was computed by the separate mock process, not
     locally, and correctly came back as allow.
   - `POST /v1/tools/execute` with `delete_everything` (dangerous) →
     `"awaiting_approval"` — same, computed remotely.
   - Pointed `AXORA_CORE_BIN` at a nonexistent path → log showed
     `core_process_unavailable_falling_back_to_local` with the real
     `spawn ENOENT` error, gateway kept running, and a subsequent
     `echo` call still executed correctly via the local fallback.
   - No `AXORA_CORE_BIN` at all (the default) → log showed
     `policy_provider_selected: "local_typescript"`, browser e2e and a
     plain tool call both still passed, zero errors — confirming the
     default path is genuinely unchanged for anyone not using this.
8. Lesson applied from the earlier process-leak bug: every live test in
   this milestone that starts a background server process keeps the
   startup, the curl calls, and the cleanup (`pkill`) all in one shell
   invocation — splitting them across separate tool calls was tried
   first and lost the backgrounded process between calls (a sandbox
   constraint, not a code bug), which is itself a small methodological
   finding worth recording here rather than silently redoing it.
9. `services/core/src/rpc.rs` — written against the exact same protocol,
   with its own `#[cfg(test)]` module (5 tests covering `dispatch()`'s
   ping/unknown-method/policy.evaluate/deny-reason/invalid-risk-level
   cases) manually traced for correctness the same rigorous way as
   Milestone 9's audit, but **not compiled** — no `rustc`. Added
   `serde`/`serde_json` as `services/core`'s first real external
   dependency, with the Cargo.toml comment explaining why that's the
   honest choice here (no verification benefit to hand-rolling JSON
   parsing in Rust the way the ZIP reader's from-scratch approach paid
   off in TypeScript, since this Rust code can't be compiled either way).

### What was NOT run (and why)

- `rpc.rs` itself — not compiled, for the reason stated throughout this
  project: no `rustc` in this sandbox. The TypeScript side's tests prove
  the *client* and the *protocol design* work; they cannot prove the
  Rust *server* implementation compiles or behaves correctly. Point
  `AXORA_CORE_BIN` at a real `cargo build --release` output and rerun
  the Milestone 10 live tests above once a toolchain is reachable —
  that's the single most valuable verification step left in this
  project.
- A real `axora-core serve` process — everything described as "Core" in
  this milestone's live tests was the mock, clearly labeled as such
  throughout. No claim here should be read as "the real Rust binary was
  tested" — only "the integration boundary it will plug into was."

---

## Milestone 11: Real OCR (`ocrParser.ts`)

Same sandbox; `rustc`/`cargo`/network still absent (unaffected by this
milestone, which needed neither).

### Why this was possible to verify for real

Checked for a `tesseract` binary and found one actually installed in
this sandbox (`tesseract 5.3.4`, with `eng` language data) — likely
preinstalled for unrelated tooling, not something this project arranged.
Also found ImageMagick's `convert` available, which can render text to a
real image via its `label:` operator. Together these made genuine,
non-mocked OCR verification possible: unlike most of the "write it
correctly, verify what's checkable" work in this project, this one
could be checked all the way through.

### What was actually run

1. A quick manual round-trip *before* writing any parser code: `convert
   ... label:"AXORA Knowledge Vault OCR test" out.png` then `tesseract
   out.png stdout` — got the exact original text back. This confirmed
   the approach would work before investing in it, the same discipline
   used for the PDF pipeline back in Milestone 6.
2. `ocrParser.ts`: shells out to `tesseract` via `execFile` (not `exec`
   — avoids shell-injection risk from the temp file path), with `sharp`
   (grayscale + normalize) preprocessing first, a real accuracy
   improvement tesseract's own docs recommend, not decoration. Writes to
   a temp file via `mkdtemp` (collision-safe, unlike a fixed filename)
   and always cleans up the whole temp directory in a `finally`, even on
   error.
3. `ocrParser.test.ts` — 4 tests, **all passed on the first run**:
   - Two different real rendered sentences, each correctly recovered
     (not hardcoded to one fixture — a second, differently-worded image
     proves the parser isn't just matching one known string).
   - Non-image input correctly throws a clear
     `"OCR preprocessing failed"` error rather than feeding garbage to
     tesseract.
   - Temp-directory cleanup verified by listing the OS tmpdir after a
     run and asserting no leftover `axora-ocr-*` directories.
4. Full regression: **97/97** across all 18 suites.
5. **Live HTTP, real image, no mocks**: rendered a real PNG with
   `convert` containing "AXORA now reads scanned images via OCR",
   uploaded it through `POST /v1/knowledge/documents/upload` with
   `sourceType: "png"` — `extractedChars: 38` matched the rendered
   sentence's length exactly. Asked a differently-worded question
   ("does AXORA support reading scanned images?") — `context_assembly`
   log confirmed the OCR'd chunk was retrieved (score 0.8). Checked
   `/tmp` after the run: zero leftover `axora-ocr-*` directories,
   confirming cleanup works under the real server process too, not just
   in the unit test's more controlled conditions.
6. Regression: browser e2e still passes, zero errors.

### What was NOT run (and why)

- Scanned/image-only PDFs — `pdfParser.ts` extracts embedded text only;
  it does not rasterize pages to images and route them through
  `ocrParser.ts`. A PDF that's purely scanned page images currently
  yields no text through either parser. Flagged as the next concrete
  step in README, not attempted this milestone.
- Non-English text, handwriting, rotated/skewed source images, or
  low-quality/noisy real-world scans — the test fixtures here are clean,
  computer-rendered, high-contrast text, which is the easy case for OCR.
  Real-world scanned documents are often much harder; `ocrParser.ts`'s
  own doc comment states this scope limit rather than implying
  general-purpose scan quality has been proven.
- Deploying without `tesseract` installed — the clear-error path (ENOENT
  → explicit message naming the missing system dependency) was written
  to the same pattern as every other "missing optional dependency" path
  in this project (`PostgresStore`, `AnthropicProvider`) but not
  separately live-tested by actually uninstalling tesseract, since doing
  so would have broken the rest of this milestone's verification too.

---

## Milestone 12: `rpc.rs` manual audit

Same sandbox; re-confirmed at the start of this session that `rustc`,
`cargo`, and `rustup` are all still absent, and network access to
`static.rust-lang.org` is still blocked.

`rpc.rs` was written in Milestone 10 but, in the rush to get the
TypeScript integration wired and live-tested, never received the same
line-by-line audit Milestone 9 gave `policy.rs`/`tools.rs`/`agent.rs`/
`main.rs`. This milestone closes that gap specifically.

### What was actually traced through

- `RpcRequest`/`PolicyEvaluateParams` deserialization via `serde_json`,
  including `#[serde(default)]` on `params: Value` (valid because
  `serde_json::Value` implements `Default`, defaulting to `Value::Null`
  — checked rather than assumed).
- The `?` operator chains in `handle_policy_evaluate` — confirmed the
  error type stays `String` throughout via explicit `.map_err(...)`
  before each `?`, so no `From` conversion ambiguity.
- `dispatch`'s match arms mixing `Ok(json!(...))` (wrapped) and
  `handle_policy_evaluate(params)` (already a `Result`) — confirmed both
  produce the same `Result<Value, String>` type, which is what match
  arm type-checking actually requires (not syntactic uniformity).
- `write_response`'s use of `writeln!(stdout, "{response}")` relying on
  `serde_json::Value: Display` (compact JSON) — confirmed this is a real
  serde_json feature, not an assumption, and traced that it produces
  exactly one NDJSON line per response, matching the protocol.
- The partial-move pattern in `serve()`: `request.params` is moved into
  `dispatch(...)`, and `request.id` is borrowed on the very next line.
  Confirmed this is valid Rust — disjoint-field access after a partial
  move of a *different* field is explicitly supported by the borrow
  checker, not a conflict.
- The `Stdin`/`StdinLock` lifetime pattern: `let stdin = io::stdin();`
  bound to a local *before* calling `.lock().lines()`, rather than
  chaining `io::stdin().lock().lines()` in one expression — deliberately
  checked because the latter has a real historical gotcha around
  temporary lifetimes in exactly this pattern; the code already used the
  safe form, confirmed rather than assumed correct.
- The test module's `assert_eq!(result["decision"], "deny")` pattern —
  confirmed `Value`'s `Index` impl returning `&Value` combined with
  serde_json's `PartialEq<str> for Value` and std's blanket
  `PartialEq<&B> for &A` impl makes this compile, the same reasoning
  applied to analogous TypeScript-adjacent... no — this is Rust-only
  reasoning, double-checked independently of any prior JS-side analysis.

### What was found and fixed

One real issue: `use serde::{Deserialize, Serialize};` imported
`Serialize` but nothing in the file derives or calls it — every response
is built via the `json!` macro, not a derived `Serialize` impl. This
would produce a genuine `cargo build` warning ("unused import"), not an
error, so it wouldn't have blocked compilation — but it's exactly the
same class of safe, mechanical fix as Milestone 9's `impl Default for
ToolRegistry`, so it was fixed the same way: removed, no logic change.

No logic bugs found. As with every prior Rust audit in this project,
this is a confidence increase, not a substitute for actually running
`cargo build` and `cargo test` — stated plainly rather than implied
otherwise.

### What was NOT run (and why)

- `cargo build` / `cargo test` on `services/core` — still no `rustc` in
  this sandbox. This remains the single most valuable verification step
  left in this entire project; everything else has been built to make
  that step as low-risk as possible once a toolchain is reachable.

---

## Milestone 13: Scanned-PDF OCR fallback (`scannedPdfOcr.ts`)

Same sandbox; unaffected by the Rust-toolchain question (TypeScript-only
work). Closes the gap explicitly flagged at the end of Milestone 11.

### What was actually run

1. Checked for a PDF rasterization tool before writing any code — found
   `pdftoppm` (part of `poppler-utils`) genuinely installed, same
   "check first, build only what's real" discipline as every other
   system-binary-dependent parser in this project.
2. `scannedPdfOcr.ts`: shells out to `pdftoppm -png -r 150` to rasterize
   each page to a real PNG in a temp directory, then feeds each page
   through the *already-verified* `ocrParser.ts` — deliberately reusing
   it rather than duplicating OCR logic. Handles poppler's page-numbered
   output filenames (`page-1.png`, `page-2.png`, ...) with numeric (not
   lexical) sorting, so page 10 doesn't sort before page 2. Wired into
   `pdfParser.ts`: when pdfjs-dist's embedded-text extraction comes back
   empty, this fallback runs automatically — no change needed by any
   caller.
3. `scannedPdfOcr.test.ts` — 3 tests, **all passed on the first run**:
   - Built a real PDF with `pdf-lib`: an embedded PNG (rendered via
     `convert`, the same fixture technique as `ocrParser.test.ts`) and
     deliberately *no* `drawText` calls — genuinely has no text layer,
     not a contrived "empty" PDF.
   - `rasterizeAndOcrPdf` called directly on it recovered the exact
     source text.
   - `pdfParser.parse()` called on the *same* scanned PDF — with no
     special-casing by the test, exactly how the gateway calls it —
     also recovered the text, proving the automatic fallback routing
     actually fires.
   - A regression guard: a normal PDF with a real text layer (built the
     same way `pdfParser.test.ts` does, via `drawText`) still returns
     correctly and fast — confirming the OCR fallback path is only
     reached when there's genuinely nothing else to extract, not taking
     over for ordinary PDFs.
4. Full regression: **100/100** across all 19 suites.
5. **Live HTTP, real scanned PDF, no mocks**: built a real PDF the same
   way (embedded rendered PNG, no text layer), uploaded it through
   `POST /v1/knowledge/documents/upload` with `sourceType: "pdf"` —
   `extractedChars: 32` matched the rendered sentence. Asked a
   differently-worded question — `context_assembly` log confirmed the
   OCR'd chunk was retrieved (score 0.4; lower than some earlier
   retrieval tests, consistent with OCR introducing minor extra
   whitespace/artifacts that slightly dilute keyword overlap — still
   correctly found). Checked `/tmp` afterward: zero leftover
   `axora-ocr-*` or `axora-pdf-ocr-*` directories.
6. Regression: browser e2e still passes, zero errors.

### What was NOT run (and why)

- Multi-page scanned PDFs — the test fixtures and live test both used
  single-page scanned PDFs. The page-sorting logic (numeric, not
  lexical) was written carefully and reviewed, but not exercised against
  an actual multi-page scanned document.
- Audio/video transcription — checked for a speech-to-text engine
  (`whisper`, `vosk`, and similar) and found none in this sandbox;
  `ffmpeg` is present but is a format/processing tool, not a
  transcription engine, so it doesn't unlock this the way `tesseract`
  and `pdftoppm` unlocked OCR. Left as the one remaining document-format
  gap in README rather than attempted with no real engine behind it.
- Deploying without `pdftoppm` installed — same pattern as every other
  missing-system-binary path in this project (clear `ENOENT`-driven
  error), not separately live-tested by uninstalling it, for the same
  reason as `ocrParser.ts`'s equivalent gap: doing so would have broken
  this milestone's other verification too.

---

## Milestone 14: Background-queue document *parsing*, not just chunking

Same sandbox; TypeScript-only change, unaffected by the Rust-toolchain
question.

### The gap, found by re-reading the project's own code

Milestone 9's `handleUploadDocument` justified parsing inline (before
the response) with the comment "parsing is typically fast relative to
chunking+storage for the document sizes this gateway handles today."
That was true when the only parsers were text/HTML/CSV/JSON — but
Milestones 11 and 13 added OCR and scanned-PDF support, both of which
can be genuinely slow (shelling out to `tesseract`/`pdftoppm`, real
image processing). The comment's own premise had quietly stopped being
true, and nothing forced revisiting it. Caught by rereading the upload
handler with current parsers in mind, not by a test failure — worth
recording as a reminder that "verified once" doesn't mean "still true
after later changes," which is part of why this project keeps a running
regression suite rather than treating each milestone's tests as
one-time checks.

### What was actually done

1. Added `Store.markDocumentFailed` (both `SqliteStore` and
   `PostgresStore`) so a background task can mark a document failed
   directly, not only via the chunking path.
2. Rewrote `handleUploadDocument`: only the genuinely fast, genuinely
   synchronous checks (sourceType supported, base64 valid) stay before
   the response. Parsing and chunking both now run inside one
   `taskQueue.enqueue(...)` call, after `createPendingDocument` but
   before `sendJson` — the document row exists and the response is sent
   before either parsing or chunking starts.
3. `tsc -p services/gateway` — no real type errors. Full regression:
   **100/100** across all 19 suites (no test needed to change — this
   altered *when* parsing runs, not what it produces).
4. **Live HTTP, measured, not assumed**: built a real scanned PDF
   (embedded image, no text layer — same fixture technique as Milestone
   13) and timed the upload request with `date +%s%N` around the `curl`
   call: **10ms** response time, for a document that genuinely requires
   OCR to process. Polled `GET /v1/knowledge/documents/:id` afterward
   and confirmed it reached `status: "ready"` on the very next poll
   (500ms later) — proving OCR really did run, just after the response
   rather than blocking it.
5. **Live-tested the new failure path** specifically: uploaded
   deliberately invalid bytes (`"this is not a real pdf file at all"`)
   as `sourceType: "pdf"`. Response still came back fast with
   `status: "pending"`; the background task's `parser.parse()` call
   threw (`InvalidPDFException: Invalid PDF structure.`), correctly
   logged via `document_parse_failed` with the document's id, and
   `markDocumentFailed` correctly left the document at
   `status: "failed"` on the next poll — never silently stuck at
   `"pending"` forever, never fabricated as `"ready"`.
6. Regression: browser e2e still passes, zero errors in any of this
   milestone's logs.

### What was NOT run (and why)

- A side-by-side timing comparison against the old inline-parsing
  behavior — the 10ms measurement is from the fixed code only; the "it
  used to block" claim rests on reading the prior code (which
  synchronously awaited `parser.parse()` before responding) rather than
  a before/after benchmark, since the old code no longer exists to
  re-measure.
- Very large documents (many-page scanned PDFs, large images) — the
  fixture used for the timing test was the same small single-page
  scanned PDF used in Milestone 13, not a stress-test-sized document.

---

## Milestone 15: Request body size limit — and a real bug in its own first fix

Same sandbox; TypeScript-only, unaffected by the Rust-toolchain
question. Found during a general re-audit pass (the same habit that
caught Milestone 14's gap): `readJsonBody` buffered a request body of
any size, with no cap, before any validation ran — a real unbounded-
memory DoS vector, more pointed now that the API accepts base64-encoded
file uploads.

### What was actually done

1. Added `MAX_BODY_BYTES` (env-configurable via `AXORA_MAX_BODY_BYTES`,
   default 50MB) and a `PayloadTooLargeError` class. `readJsonBody`
   checks the running total per chunk, not after accumulating
   everything, so an oversized body is caught as early as possible.
2. Refactored all 8 handlers that parsed a JSON body (memories,
   plain-text ingest, upload, tool execute, agent-run create, action
   decision, chat completions) from individual near-identical
   try/catch blocks onto one shared `parseJsonBody(req, res)` helper
   that sends the correct response itself. This was a deliberate
   design choice, not just tidying: a fix applied to one shared
   function reaches all 8 call sites at once, rather than depending on
   whoever edits each handler remembering to add the same check.
3. `tsc` — no real type errors. Full regression after the refactor
   (before the size-limit bug below was found): **100/100**.
4. **First live test of the actual size limit found a second, more
   interesting bug**: started the gateway with `AXORA_MAX_BODY_BYTES=1000`
   and sent an oversized request — curl reported `(52) Empty reply from
   server`, not a 413. Root cause: the oversized-body handler called
   `req.destroy()` before throwing, and in Node's `http` module the
   request and response share the same underlying TCP socket —
   destroying the request tears down the connection the 413 response
   needed to be written on. This is exactly the kind of bug that a
   unit test mocking `req`/`res` as separate objects would never catch,
   because real request/response coupling is an HTTP-server-level
   property, not a logic-level one — which is why this was caught by
   curling the real running server rather than by `node --test`.
5. Fixed: removed `req.destroy()`; the oversized-body error now
   propagates without touching the socket, and `parseJsonBody` sets
   `Connection: close` before sending the 413 so the client and server
   both know not to reuse the connection — the leftover unread body
   bytes are discarded by closing the socket *after* the response is
   flushed, not by killing it mid-request.
6. Full regression after the fix: still **100/100** (no unit test
   exercises this path directly — see "what was not run" below).
7. **Live HTTP, re-run after the fix**: same `AXORA_MAX_BODY_BYTES=1000`
   setup — a small request still returned `201` normally; the oversized
   request now correctly returned `413` with
   `{"error":"payload_too_large","detail":"request body exceeded 1000
   bytes"}`; a subsequent request on a fresh connection to `/v1/health`
   still returned `200`, confirming the server keeps accepting new
   connections afterward rather than the fix having broken something
   else to get the 413 out. Full default-config regression (no env
   override) also rerun: browser e2e still passes, zero errors.

### What was NOT run (and why)

- An automated unit test for `parseJsonBody`/`readJsonBody`'s size-limit
  behavior — `server.ts` is structured as an entrypoint script (it calls
  `main()` directly and exports nothing), not an importable module, so
  nothing in it has ever had a `*.test.ts` file; its behavior has been
  verified exclusively through live HTTP tests throughout this entire
  project (every milestone's "Live HTTP" section), and this follows
  that same established pattern rather than being a newly-introduced
  gap. Refactoring `server.ts` into testable exported units would be a
  real, larger architectural change, not attempted here.
- Testing the exact byte boundary (a body of precisely `MAX_BODY_BYTES`
  vs. `MAX_BODY_BYTES + 1`) — the live test used a limit of 1000 bytes
  against a ~2000+ byte body, well past the boundary, not an off-by-one
  check at the edge.

---

## Milestone 16: Rate limiting (`RateLimiter`, master spec section 43)

Same sandbox; TypeScript-only, unaffected by the Rust-toolchain
question. The master spec explicitly requires rate limiting; nothing
enforced it until this milestone.

### What was actually done

1. `core/rateLimiter.ts`: a real token-bucket implementation — per-key
   buckets (capacity + refill rate), with the clock injectable
   (`now: () => number`) specifically so tests can be deterministic and
   instant instead of depending on real `setTimeout` delays.
2. `core/rateLimiter.test.ts` — 8 tests written before wiring it into
   `server.ts`, using a fake-clock helper (`advance(ms)`) rather than
   real sleeps.
3. **A real bug caught while writing the tests, before anything ran
   against it for real**: the first `evictIdle` implementation checked
   `bucket.tokens >= capacity` to decide whether an idle bucket was
   safe to remove. But `tokens` is only recalculated lazily, inside
   `tryConsume` — an idle bucket (by definition, not being
   `tryConsume`'d) never gets its stored `tokens` field updated to
   reflect the refill it conceptually would have had. Writing a test
   for "evict buckets that are full and idle" made this obvious before
   the test even ran: there was no code path that would ever make an
   idle bucket's stored `tokens` read as full. Fixed by switching the
   eviction criterion to idle time alone, with a doc comment explaining
   why (idle-long-enough is behaviorally equivalent to full, since a
   fresh bucket created on next use is indistinguishable from a
   refilled one).
4. After the fix, all 8 tests passed, including: capacity/rejection,
   refill-over-time recovery, independent per-key buckets, accurate
   (non-constant) `retryAfterSeconds` reflecting the actual configured
   refill rate, capping at capacity even after a very long idle period,
   constructor validation, and two `evictIdle` tests (idle-threshold
   respected; `evictIdle(0)` clears everything).
5. `tsc -p services/gateway` — no real type errors. Full regression:
   **108/108** across all 20 suites.
6. Wired into `server.ts`: every route except `/v1/health` is
   rate-limited by `req.socket.remoteAddress`, configurable via
   `AXORA_RATE_LIMIT_CAPACITY`/`AXORA_RATE_LIMIT_PER_SECOND` (defaults:
   burst 20, refill 1/sec = 60/min sustained), with a periodic
   `evictIdle` sweep (`setInterval(...).unref()`, never keeps the
   process alive on its own) so long-running processes don't accumulate
   one bucket per distinct IP forever.
7. **Live HTTP, deliberately low limit for a fast test**
   (`AXORA_RATE_LIMIT_CAPACITY=3`, `AXORA_RATE_LIMIT_PER_SECOND=0.5`):
   fired 5 rapid requests at `/v1/tools` — the first 3 succeeded
   (`200`), the 4th and 5th correctly got `429` with response body
   `{"error":"rate_limited","retry_after_seconds":2}` and a matching
   `retry-after: 2` HTTP header. Checked `/v1/health` 5 times during the
   same active rate-limit window — all 5 succeeded, confirming the
   exemption actually works, not just that it's written.
8. **Live HTTP, recovery test** (separate run, `capacity=2`,
   `refillPerSecond=2`): exhausted the bucket (2 requests succeed, 3rd
   `429`), waited 1 real second, confirmed a 4th request succeeded —
   the refill genuinely happens over wall-clock time in the running
   server, not just in the fake-clock unit tests.
9. Default-config regression (no rate-limit env overrides): browser
   e2e still passes, zero errors.

### Follow-up: concurrency, closed in the same session

The "not run" list below originally included concurrent-load behavior.
Closed immediately after, in the same continuation:

1. Two new unit tests added to `rateLimiter.test.ts`: 50 concurrent
   `tryConsume("hot-key")` calls via `Promise.all` (each forced through
   a `setImmediate` hop first, so they don't trivially serialize by
   construction) against a capacity-10 bucket — asserted **exactly** 10
   grants, not more (over-granting) or fewer (lost/double-counted
   tokens). A second test ran 20 keys × 2 concurrent attempts each
   against capacity-1 buckets, asserting exactly 1 grant per key — no
   cross-contamination between buckets under concurrency. Both passed;
   full suite went from 8 to 10 tests, still 100% pass, confirmed
   against the full 20-suite/110-test regression.
2. **Live HTTP, genuinely concurrent** (not sequential `curl` calls):
   fired 15 simultaneous requests at a capacity-5 bucket
   (`AXORA_RATE_LIMIT_CAPACITY=5`) using backgrounded shell jobs — got
   back exactly 5×`200` and 10×`429`, matching the unit-level proof at
   the real HTTP layer. Getting this test running took two failed
   attempts first, both sandbox/shell issues rather than application
   bugs: (a) a bare `wait` with no arguments waits on *every*
   background job in the shell, including the still-running server
   process itself, not just the intended `curl` calls — hung for the
   full 300s tool timeout before this was diagnosed; (b) a bash-array
   (`PIDS=()`) snippet failed because this sandbox's shell is POSIX
   `sh`, not `bash`. Resolved by backgrounding the curls with output
   redirected to files and a fixed `sleep` instead of explicit process
   waits, and starting the server in a detached `(... &)` subshell — the
   same pattern already used successfully for every other concurrent
   live test in this project (Milestone 7, Milestone 10), which in
   hindsight should have been used from the start here too.

### What was NOT run (and why)

- `X-Forwarded-For`-aware client identification for deployments behind a
  reverse proxy (where `req.socket.remoteAddress` would be the proxy's
  address, not the real client's) — out of scope for this sandbox's
  direct-connection testing; a real deployment behind a proxy would need
  this to rate-limit by actual client IP rather than lumping every
  client behind the proxy into one bucket. Deliberately not added
  speculatively: trusting an `X-Forwarded-For` header without also
  validating it comes from a trusted proxy is itself a spoofing risk,
  and there's no real proxy in this sandbox to test that validation
  against.

---

## Milestone 17: Secret Vault (`SecretVault`, `secretCrypto.ts`, master spec section 26)

Same sandbox; TypeScript-only, unaffected by the Rust-toolchain
question (rechecked at the start of this session — still no `rustc`,
still no network to `static.rust-lang.org`).

Note on continuity: this milestone's work was originally done and
fully tested in an earlier session, but the sandbox's working directory
reset before it could be packaged into a delivered zip (only files
copied to `/mnt/user-data/outputs/` survive a reset — the live
`/home/claude/axora` working tree does not). It was redone from
scratch this session, identically, against the restored
Milestone-16 baseline. Recorded here plainly as a reminder: **only
packaged/delivered output is durable in this environment** — mid-session
work that hasn't been zipped yet is one reset away from needing to be
redone.

### What was actually done

1. `secretCrypto.ts`: real AES-256-GCM via Node's built-in `crypto`
   module (`createCipheriv`/`createDecipheriv`) — no external
   dependency, no hand-rolled cryptography. A fresh random IV every
   call (reusing an IV under GCM is the one mistake that actually
   breaks its security guarantee), master key validated to exactly 32
   bytes (AES-256) with a clear error naming the actual decoded length
   on mismatch.
2. `secretCrypto.test.ts` — 12 tests, all passing first run: round-trip;
   confirmed the ciphertext is genuinely encrypted (not just
   base64-encoded plaintext); two encryptions of identical plaintext
   produce different IVs and ciphertext (both still independently
   decrypt correctly); **three separate tamper-detection tests** —
   flipping a bit in the ciphertext, the auth tag, and the IV
   independently all correctly throw rather than decrypting to garbage,
   which is the actual point of using authenticated encryption instead
   of plain AES-CBC; decrypting under the wrong key throws; key-length
   validation rejects both too-short and wrong-algorithm-sized (16-byte
   AES-128) keys; `generateMasterKey()` always produces a key its own
   `parseMasterKey()` accepts, and produces a different key every call.
3. `SecretVault` (wraps `secretCrypto.ts` with `Store` persistence and
   access auditing) + `secretVault.test.ts` — 7 tests: round-trip
   through real `SqliteStore`; not-found returns `undefined`, not an
   error; `listSecretNames()` returns names only, with an explicit
   check that neither stored plaintext value appears anywhere in the
   serialized names response; delete revokes (subsequent `getSecret`
   returns `undefined`); deleting a nonexistent name returns `false`,
   not an error; setting the same name twice overwrites (rotation) and
   leaves exactly one entry, not two; **every vault operation is
   audited via the existing action log** — verified all four expected
   log entries appear with correct `resultStatus`, and that the
   plaintext value never leaks into the serialized log; decrypting
   under a different vault instance's key (simulating a changed
   `AXORA_SECRET_KEY`) throws rather than returning corrupted data.
4. `db/migrations/0001_init.sql`: new `vault_secrets` table (name,
   ciphertext, iv, auth_tag, version, timestamps) — stores only the
   encrypted payload, never plaintext, matching what `SqliteStore` and
   `PostgresStore` both actually persist.
5. `tsc -p services/gateway` — no real type errors. Full regression:
   **129/129** across all 22 suites.
6. Wired into `server.ts`: `POST /v1/vault/secrets` (set),
   `GET /v1/vault/secrets` (list names only), `DELETE
   /v1/vault/secrets/:name` (revoke). Deliberately **no endpoint
   returns a decrypted value** — `SecretVault.getSecret()` exists for
   future internal code (a connector implementation reading a key
   before an outbound call) to call programmatically, never for an HTTP
   client to retrieve a value through. This is the literal spec
   requirement ("never expose API keys directly to frontend clients"),
   not a cautious guess at one. The vault only activates when
   `AXORA_SECRET_KEY` is set; otherwise its endpoints return a clear
   `503` and the rest of the gateway is unaffected.
7. **Live HTTP, no mocks**: generated a real random master key, set a
   secret, confirmed `GET /v1/vault/secrets` returns only
   `{"names":["anthropic_api_key"]}` — grepped the full response body
   for the plaintext value and got zero matches. Deleted it, confirmed
   the list went back to empty, confirmed a second delete attempt
   correctly `404`s. Fetched `/v1/action-log` and confirmed the full
   audit trail: `vault.set:... -> success`, `vault.delete:... ->
   success`, `vault.delete:... -> failed` (the second, already-gone
   attempt) — all present and correctly attributed. Separately started
   the gateway with no `AXORA_SECRET_KEY` at all and confirmed
   `POST /v1/vault/secrets` returns `503 secret_vault_not_configured`
   while `/v1/health` still returns `200` — the feature being disabled
   doesn't take anything else down with it.
8. Regression: browser e2e still passes, zero errors in any log from
   this milestone.

### What was NOT run (and why)

- Key rotation in the sense of re-encrypting *existing* secrets under a
  new master key — `SecretVault` detects a key mismatch correctly
  (throws rather than corrupting data, tested above), but there's no
  "re-encrypt everything under a new key" operation built yet. A real
  rotation today means: decrypt each secret under the old key, set it
  again under the new key, one at a time — not automated.
  `vault_secrets.version` increments on every `setSecret` call (visible
  in the schema) but isn't yet surfaced anywhere or used for anything
  beyond that counter.
- `PostgresStore`'s vault methods — no Postgres server in this sandbox,
  same reason as every other `PostgresStore` method in this entire
  project. SQL reviewed by hand against the schema, not executed.
- Real connector credentials actually being used by a real connector —
  no connectors (GitHub, Google Drive, etc. — master spec section 25)
  are built yet, so there's nothing yet that calls `getSecret()` for a
  real outbound API call. The vault is ready for that; the connectors
  themselves are still unstarted.

---

## Milestone 18: Real web UI (chat + memory + knowledge vault + tools/actions + conversation history replay)

Same sandbox; frontend + one small backend addition, unaffected by the
Rust-toolchain question (rechecked at the start of this session — still
no `rustc`, and DNS for `static.rust-lang.org` doesn't even resolve).

Continuity note, second occurrence: this milestone was originally built
and fully tested earlier in the same session, then lost when the
sandbox's working directory reset again — this time more severely than
before (`/home/claude` itself was empty). `axora-master.zip` in
`/mnt/user-data/outputs/` survived and was used to restore the
Milestone-17 baseline; the UI was rebuilt identically, and the one
remaining gap it had (history replay, described below) was closed in
the same pass. **From this point on, the working practice is: save a
zip to `/mnt/user-data/outputs/` immediately once a chunk of work is
verified, before continuing — not at the end of a milestone.** Only
packaged output survives a reset here.

This milestone closes the biggest gap flagged in `PROJECT_MASTER.md`'s
Phase 3 (User Experience) status: before it, only a bare static test
client existed.

### What was actually built

1. A full rewrite of `apps/web/public/index.html` — still one
   dependency-free HTML/CSS/JS file (no build step, no framework:
   Next.js isn't installable offline here, and a real build pipeline
   would need network access this sandbox doesn't have), but now a
   genuine multi-view product UI:
   - **Sidebar**: AXORA branding, new-chat button, live conversation
     list from `GET /v1/conversations`, four-view navigation, live
     connection-status indicator.
   - **Chat**: SSE streaming rendered incrementally, a lightweight
     Markdown renderer (bold/italic/inline code/code blocks —
     HTML-escaped *before* any replacement, so it can't be an XSS
     vector), mode selector, auto-resizing composer.
   - **Memory**: add a memory (category, content, global or
     conversation-scoped), live stored list.
   - **Knowledge Vault**: real file upload (`FileReader` → base64 →
     `POST /v1/knowledge/documents/upload`, `sourceType` inferred from
     extension), live document list with status badges.
   - **Tools & Actions**: registered-tools list, a tool-execution form,
     and the action log with **working Approve/Reject buttons** for
     `awaiting_approval` entries — the approval-resume flow from
     Milestone 5 now has a real UI, not just an API.
   - Dark/light theme (OS-aware, manual override persisted in
     `localStorage` — appropriate for a real served page the user runs
     themselves, not a Claude.ai Artifact subject to that separate
     tool's storage restrictions).
2. **Conversation history replay** — the named gap from the first
   version of this milestone, closed in the same session: the UI could
   list conversations but clicking one just showed a "switched
   conversations" note with no actual history. Added
   `GET /v1/conversations/:id/messages` to the gateway
   (`Store.getMessages()` already existed, used internally — this just
   exposes it). While writing the handler I nearly used
   `Store.ensureConversation()` to fetch the conversation, then caught
   before ever compiling that it **creates a row as a side effect** —
   wrong for a `GET`, which must stay read-only. Fixed to call
   `getMessages()` directly, which simply returns an empty array for an
   unknown conversation id (the correct, honest answer — no messages
   yet — not an error). `openConversation()` in the UI now fetches and
   renders the real stored history.

### What was actually run

1. Full Playwright pass over every view against the real running
   gateway: chat send + streaming render; Memory add + list with
   correct metadata; Knowledge Vault empty state; Tools list, executing
   the low-risk `echo` tool (correct `executed` outcome rendered),
   executing the dangerous `delete_everything` tool (correct
   `awaiting_approval` outcome), **clicking the real Approve button in
   the UI** and confirming the action log entry flipped to `success`;
   "New chat" creating a second conversation with the sidebar updating
   to show both; theme toggle cycling `unset → light → dark`. **Zero
   bugs found on this first full pass** — worth stating plainly rather
   than implying fixes that weren't needed — and zero browser console
   errors, zero gateway log errors.
2. A separate Playwright test for **real file upload**: wrote an actual
   `.txt` fixture to disk, attached it through the real
   `<input type="file">` element via `setInputFiles` (not a scripted
   API call bypassing the UI), clicked Upload, refreshed, confirmed
   `status: "ready"`, then asked the chat a differently-worded question
   about the file's content and confirmed via the gateway's
   `context_assembly` log that the uploaded document's chunk was
   retrieved (score 0.857) — the full upload-to-retrieval pipeline
   exercised through the actual browser, not just the API.
3. **History replay test, with one false start worth recording**: the
   first version of the test script failed with a stale-element error
   after its first click — a bug in the *test script*, not the app
   (clicking a sidebar item re-renders the whole sidebar, detaching any
   element handles captured beforehand). Notably the first click had
   already produced the correct result before the script crashed.
   Fixed by re-querying `.conv-item` elements fresh before every click.
   The corrected test created two real conversations with distinct
   messages ("conversation A: alpha topic" / "conversation B: beta
   topic"), then clicked each sidebar entry in turn and confirmed each
   showed **only its own** history — not both showing the same one, not
   a leak between them — with zero console errors.
4. Backend regression after all of this: **129/129** across all 22
   suites; `tsc` — no real type errors.

### What was NOT run (and why)

- Any browser other than the Chromium Playwright drives — no way to
  launch Firefox/Safari here.
- Mobile/narrow-viewport behavior — the CSS uses a fixed 260px sidebar
  with no responsive breakpoints; this UI is built and tested for a
  standard desktop window only.
- Behavior with a genuinely offline gateway mid-session — the UI's
  `catch` blocks were written to handle `fetch` failures but weren't
  exercised by killing the server and watching what the UI does.
- Only the first two message roles (`user`/`assistant`) are replayed in
  history; `system`/`tool` roles stored by the gateway are skipped in
  the UI on purpose (they'd be noise, not conversation), but this
  wasn't separately tested with a conversation that actually contains
  one.
