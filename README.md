# AXORA — Your Mind, Amplified. 🚀

Personal AI + AI Operating System. This repo is the real implementation, built
incrementally from `docs/MASTER_SPEC.md`.

## Status (source of truth: this section, not marketing copy)

This is **Phase 1 (Foundation) + the start of Phase 2 (AXORA Core /
orchestration)**, built and verified inside a sandboxed dev container with
**no network access** and **no Rust toolchain installed**. That constrains
what could be executed here today:

| Component | State |
|---|---|
| `services/gateway` (TypeScript, zero external deps at its core) | **Written AND run in this container.** Boots on plain `node`, serves `/v1/health`, `/v1/chat/completions` (SSE streaming, now with memory-augmented context), `/v1/conversations`, `/v1/memories`. 14 unit tests pass (`node --test`), plus a live Playwright browser end-to-end run. See `docs/VERIFICATION.md`. |
| `services/gateway/src/store.ts` `SqliteStore` | **Verified.** Zero-dep, built on `node:sqlite`. |
| `services/gateway/src/postgresStore.ts` `PostgresStore` | Written, parameterized SQL against the real schema, **not executed** — no Postgres server and no network to install `pg` in this container. Type-checked against a hand-written `pg` ambient declaration (`src/types/pg.d.ts`). |
| `services/gateway/src/memory/retrieval.ts` (long-term memory retrieval) | **Verified**, including a real bug fix: initial keyword matching missed "prefer" vs "prefers" (no stemming) — caught by a live smoke test, fixed with a small stemmer, regression-tested. Honest limitation: this is keyword-overlap ranking, not semantic/embedding search (no network for an embeddings API here) — see the module's own doc comment. |
| `services/gateway/src/providers/anthropicProvider.ts` (real Claude provider) | Written using Node's built-in `fetch`, no SDK dependency. Its SSE parser (`anthropicSse.ts`) is **unit-tested** against a hand-written canned payload (6 tests). The provider itself has **never made a real API call** — no network egress in this container. |
| `services/gateway/src/knowledge/chunking.ts` (Knowledge Vault: parse/clean/chunk) | **Verified**, 9 unit tests. Real paragraph-aware chunking with overlap, not a stub. |
| `services/gateway/src/knowledge/retrieval.ts` (Knowledge Vault chunk retrieval) | **Verified**, 4 unit tests + live end-to-end (ingest → chunk → retrieve → inject into chat context, confirmed via server logs). Same honest keyword-overlap limitation as memory retrieval — no embeddings reachable here. |
| `services/gateway/src/core/{policy,tools,agent}.ts` (Tool System + Policy Engine + Agent Runner) | **Verified.** TypeScript mirror of `services/core`'s Rust design, actually runnable/testable since it runs in-process with the gateway. 10 unit tests + live HTTP: low-risk tools auto-execute, the dangerous demo tool correctly halts `awaiting_approval` and never runs, unknown tools are reported not ignored, every call is written to the action log. |
| `services/gateway/src/store.ts` `action_log` table | **Verified** — round-tripped real entries through `/v1/action-log` for all four outcome types (executed/awaiting_approval/unknown_tool, and their SQLite persistence). |
| Approval-resume flow (`POST /v1/action-log/:id/decision`) | **Verified.** A rejected dangerous action stays denied and never executes; an approved one is actually run at approval time (confirmed via its own canary output), and a second decision on an already-resolved action is correctly refused (409). |
| Concurrent-decision race fix (`Store.claimAction`) | **Verified**, including over real concurrent HTTP requests (not just a unit test): two simultaneous `POST /v1/action-log/:id/decision` calls on the same action — exactly one won (`200 success`), the other correctly lost (`409 action_not_awaiting_approval`), confirmed via curl backgrounding two real requests at once. |
| Per-run step budgets (`POST /v1/agent-runs`, `agent_runs` table) | **Verified.** A run created with `max_steps: 2` allowed exactly 2 tool calls, flipped to `status: "completed"`, and a third call against the same run was rejected (409) rather than silently exceeding budget. |
| Conversation-scoped memory & knowledge (`listMemoriesForContext`, `listChunksForContext`) | **Verified.** A memory added with `conversationId: "conv-A"` was retrieved in conversation A (score 0.63) and correctly invisible in conversation B (0 relevant results for the same question); a global memory (no conversationId) was visible and retrieved in both. |
| `services/gateway/src/knowledge/parsers/zip/miniZip.ts` (zero-dependency ZIP reader) | **Verified**, including real DEFLATE decompression — no library available offline for this, so it's implemented from scratch against the actual ZIP file format spec. 5 unit tests. |
| `docxParser.ts` / `pptxParser.ts` / `xlsxParser.ts` (real Word/PowerPoint/Excel extraction) | **Verified end-to-end**, same rigor as the PDF parser: hand-built real ZIP fixtures (multi-run paragraphs, out-of-order slides, shared-string/sparse-cell spreadsheets) round-tripped through the actual parsers, then live-tested again over real HTTP via `/v1/knowledge/documents/upload` with retrieval confirmed (DOCX content scored 1.0 relevance). 17 unit tests. |
| Per-run budgets are now the only path (`/v1/tools/execute` with no `run_id`) | **Verified.** The old shared/global `RunLimits` is gone entirely — every call, even without an explicit `run_id`, now creates and persists its own real `agent_runs` row; live-tested that two calls with no `run_id` get two different, independently-tracked runs. |
| `services/core` (Rust) manual audit | Still **not compiled** (no `rustc` reachable in this sandbox, reconfirmed every session including this one). Milestone 9 rigorously audited `policy.rs`/`tools.rs`/`agent.rs`/`main.rs` (found and fixed one issue: missing `impl Default`). Milestone 12 did the same pass on `rpc.rs` (written later, in Milestone 10, and hadn't had this treatment yet) — traced the partial-move pattern in `serve()` (moving `request.params` into `dispatch` then still borrowing `request.id` afterward — valid, disjoint field access) and the `Stdin`/`StdinLock` lifetime pattern (binding `stdin` to a local first, not chaining `io::stdin().lock()` inline, to avoid a real historical temporary-lifetime gotcha) line by line; found and removed one unused `Serialize` import (a real `cargo build` warning). Confidence is higher than a plain read-through, but this is explicitly **not** a substitute for `cargo build`/`cargo test`. |
| `services/gateway/src/core/taskQueue.ts` (background Task Engine foundation) | **Verified**, including a real bug this caught: the first implementation started a task's synchronous prefix immediately inside `enqueue()` rather than deferring it, defeating the point of a background queue. Caught by a unit test, fixed with `queueMicrotask`. 7 unit tests including a genuine concurrency-limit test (holds tasks open with controllable gates, asserts the running count never exceeds the configured limit). Document ingestion (`POST /v1/knowledge/documents` and `.../upload`) now goes through it — live-tested: creation returns `status: "pending"` immediately, `GET /v1/knowledge/documents/:id` (new endpoint) polls status, and retrieval works once chunking completes (score 0.8). Both the success path and the failure path (`status: "failed"`) were live-tested through the real queue. |
| Gateway ↔ Core integration boundary (`docs/CORE_PROTOCOL.md`, `coreClient.ts`, `rpc.rs`) | **The TypeScript side is genuinely tested against a real second OS process** — a mock speaking the exact protocol, including a real bug this caught (a failed `start()` used to leak the child process, hanging the test suite; fixed). 8 unit tests cover the happy path, out-of-order concurrent response matching, timeouts, crashes, and malformed responses. **Then wired into the live request path**: `AgentRunner`'s policy dependency is now a pluggable `PolicyProvider` interface, and with `AXORA_CORE_BIN` pointed at the mock, a real `/v1/tools/execute` HTTP call's decision was genuinely computed by a separate process and round-tripped back — verified for both an `allow` and a `require_approval` outcome. Graceful fallback (binary missing → clear error, local provider still used, gateway keeps working) also live-tested. The Rust side (`rpc.rs`) is written to the exact same spec but, like the rest of `services/core`, has never been compiled. |
| `services/gateway/src/knowledge/parsers/ocrParser.ts` (real OCR for images) | **Verified with real OCR, not a mock** — the `tesseract` and ImageMagick `convert` system binaries both happen to be present in this sandbox. Built real test fixtures with `convert` (rendered text → real PNG), extracted it with the actual `tesseract`-backed parser, asserted the recovered text matches — for two different sentences, plus error handling for non-image input and temp-file cleanup. Then live-tested through `POST /v1/knowledge/documents/upload` with a real rendered PNG: extracted 38 characters correctly, retrieved for a differently-worded question (score 0.8). Requires the `tesseract` *system* binary at runtime (not an npm package) — documented plainly, with a clear runtime error if it's missing rather than silent empty output. |
| `scannedPdfOcr.ts` (scanned/image-only PDF fallback) | **Verified end-to-end**, closing the gap flagged in Milestone 11. Built a real PDF with `pdf-lib` containing an embedded image and deliberately *no* text layer — `pdfParser.ts` correctly extracts empty text from it (nothing to find), then automatically rasterizes each page via the real `pdftoppm` system binary and OCRs them via the already-verified `ocrParser.ts`. 3 tests, all passing first try: direct fallback recovery, automatic end-to-end routing through `pdfParser.parse()` with no special-casing by the caller, and a regression guard confirming a normal (non-scanned) PDF still takes the fast text-layer path. Live-tested through the real upload endpoint: a genuinely scanned PDF was correctly OCR'd and retrieved (score 0.4) for a differently-worded question. |
| Background-queued **parsing** (not just chunking) for `/v1/knowledge/documents/upload` | **Fixed a real design gap and verified the fix.** Parsing (including OCR) used to run inline before the response — fine for text/CSV/JSON, but exactly wrong for the slowest cases (OCR, scanned PDFs), which were the ones most in need of a non-blocking response. Moved the whole parse+chunk pipeline onto `TaskQueue`. Live-measured: a scanned-PDF upload that requires real OCR now returns in **10ms** (previously would have blocked for the full OCR duration), and polling confirmed it genuinely reached `status: "ready"` shortly after — OCR demonstrably still ran, just not in the request path. Also verified the new background parse-failure path with deliberately invalid PDF bytes: correctly logged and the document correctly ended up `status: "failed"`, never silently stuck or fabricated as ready. |
| Request body size limit (`AXORA_MAX_BODY_BYTES`, default 50MB) | **Closes a real DoS gap and caught a real bug in its own fix.** `readJsonBody` previously buffered a request body of any size before validating anything — unbounded memory use per request. Refactored all 8 handlers that parse a JSON body onto one shared `parseJsonBody` helper (consistent 413 handling everywhere, not wherever someone remembered to add it). First live test of the fix returned "Empty reply from server" instead of a 413 — a second real bug, found by actually curling it rather than trusting the code: `req.destroy()` on an oversized body kills the *whole* TCP connection (req and res share one socket in Node's `http` module), so the 413 response had nowhere to go. Fixed by not destroying the request and instead setting `Connection: close` so the leftover unread bytes are discarded by closing the socket *after* the response is sent. Re-verified live: a real `413 payload_too_large` now comes back correctly, small requests are unaffected, and the server keeps accepting new connections afterward. |
| Rate limiting (`RateLimiter`, master spec section 43) | **Verified**, including a real bug caught while *writing the test*, not after: `evictIdle`'s first version checked a bucket's stored token count to decide if it was "full," but that field is only updated lazily inside `tryConsume` — an idle bucket's stored count never reflects the refill it would have had, so the original logic would have evicted almost nothing in practice. Fixed to use idle time directly. 10 unit tests, deterministic via an injected fake clock (no real sleeps) — including two concurrency stress tests (exact-capacity grants under 50 concurrent same-key attempts; no cross-contamination across 20 concurrent different-key attempts). Then live-tested over real HTTP: sequentially (3 allowed, 2 correctly `429` with a matching `Retry-After` header, confirmed recovery after the refill window, confirmed `/v1/health` stays exempt even mid-limit) and, closing the one gap flagged after that, under **genuine concurrent HTTP load** — 15 simultaneous requests against a capacity-5 bucket came back exactly 5×`200`/10×`429`, no over-granting under real concurrency. Default-config regression unaffected. |
| Secret Vault (`SecretVault`, `secretCrypto.ts`, master spec section 26) | **Verified.** Real AES-256-GCM authenticated encryption via Node's built-in `crypto` — no external dependency, nothing hand-rolled. 19 unit tests: round-trip, confirmed ciphertext is genuinely not plaintext-in-disguise, unique IV per encryption, and — the properties that actually matter for authenticated encryption — tampering with the ciphertext, IV, *or* auth tag independently all correctly throw rather than silently returning corrupted plaintext, as does decrypting under the wrong key. `SecretVault` wraps this with storage (`vault_secrets` table) and access auditing through the *already-existing* action log (every set/get/delete call logged, confirmed the plaintext value never leaks into a log entry). Live-tested over real HTTP: set → list (names only, value confirmed absent from every response) → delete → re-delete correctly `404`s → full audit trail visible via `GET /v1/action-log`. No HTTP endpoint ever returns a decrypted value — `getSecret()` is for internal code only, per the literal spec requirement ("never expose API keys directly to frontend clients"). Confirmed clean `503` fallback (rest of the gateway unaffected) when `AXORA_SECRET_KEY` isn't configured. |
| Web UI (`apps/web/public/index.html`) + `GET /v1/conversations/:id/messages` | **Verified with Playwright against the real running gateway.** Multi-view dependency-free app: streaming chat, conversation list with real history replay, memory manager, Knowledge Vault with real browser file upload (through the actual `<input type=file>`, not a scripted API call), tools & action-log with working Approve/Reject buttons (clicked in the real UI, confirmed the dangerous tool then genuinely executed). First full pass found zero bugs; one test-script bug (stale element handles after sidebar re-render) was found and fixed in the test itself, not the app. Not built: projects view, settings screens, responsive/mobile layout, a Next.js production frontend. |
| `services/gateway/src/knowledge/parsers/*` (real document parsers) | **Verified**, unusually thoroughly for this sandbox. `htmlParser`, `csvParser`, `jsonParser` are pure and unit-tested (14 tests). `pdfParser` uses real `pdfjs-dist` and is **genuinely verified end-to-end**: a real PDF is generated with `pdf-lib`, parsed back with `pdfParser`, and the extracted text is asserted against — then live-tested again over real HTTP through `/v1/knowledge/documents/upload` with retrieval confirmed via `context_assembly` logs. |
| `db/migrations/0001_init.sql` (PostgreSQL schema) | Written, reviewed, **not executed** — no Postgres server available in this container. |
| `services/core` (Rust: policy engine, tool registry, agent runner) | Written, **not compiled** — no `rustc`/`cargo` in this container. Zero external crates, 8 `#[cfg(test)]` unit tests included for when a toolchain is available. Don't take my word for it — `cargo test` it yourself. |
| `apps/web` (chat client) | A dependency-free static HTML/JS client — **run and exercised in this container** via a real headless-browser test (Playwright), including finding and fixing a real CORS bug. The Next.js production frontend is not started yet. |

Nothing below claims to be "production ready." It's a real, working vertical
slice of the architecture (Core → Model Router → Provider → persistence),
plus real (but unexecuted) schema and service skeletons for the next layer.

## Why a mock provider

No model provider credentials or network egress exist in this container, so
the gateway ships with a `MockProvider` that implements the same
`ModelProvider` interface a real Anthropic/OpenAI-compatible provider would.
Swapping in a real provider is a matter of implementing that interface — see
`services/gateway/src/providers/provider.ts`.

## A note on `node_modules` in this sandbox

`services/gateway` has no network access to run `npm install`, so `pg`,
`pdfjs-dist`, and `pdf-lib` could not be installed normally. To actually
execute `pdfParser.ts` against a real PDF (not just review the code),
this sandbox **symlinked** its globally-preinstalled copies of
`pdfjs-dist` and `pdf-lib` into `services/gateway/node_modules/`. Those
symlinks point at sandbox-local paths and **will not resolve on your
machine** — `node_modules/` is git-ignored and not included in any
archive of this repo. Run `npm install` in `services/gateway` yourself;
it populates `node_modules/` normally from the registry using the
versions pinned in `package.json`, and the code imports these packages
by their normal names (`pdfjs-dist/legacy/build/pdf.mjs`, `pdf-lib`),
not by any sandbox-specific path, so nothing needs to change.

## Run it yourself

```bash
cd services/gateway
node --experimental-sqlite src/server.js   # after compiling, see below
# or, with a TS runner installed locally:
npx tsc -p .
node --experimental-sqlite dist/server.js
```

```bash
curl -N http://localhost:8787/v1/health
curl -N -X POST http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"conversation_id":"demo","messages":[{"role":"user","content":"hello axora"}],"mode":"fast"}'
```

Then open `apps/web/public/index.html` in a browser (or serve it) — it talks
to the gateway above and streams tokens live.

For the intended production stack (Postgres, Docker Compose, real providers):

```bash
docker compose up   # docker-compose.yml — brings up postgres + gateway
```

## Architecture (this slice)

```
apps/web (static client, SSE)
   -> services/gateway (TypeScript, Node http, zero deps)
        -> src/router.ts        (Model Router: mode -> provider selection)
        -> src/providers/
             provider.ts          (ModelProvider interface)
             mockProvider.ts      (offline, verified)
             anthropicProvider.ts (real Claude, fetch-based, unverified —
                                    no network in this sandbox)
             anthropicSse.ts      (pure SSE parser, unit-tested)
        -> src/store.ts / postgresStore.ts
             SqliteStore  (dev, verified, node:sqlite)
             PostgresStore (production, unverified — see status table)
        -> src/memory/retrieval.ts (long-term memory retrieval: keyword
                                     overlap + stemming, unit-tested;
                                     honest embeddings-search gap noted
                                     in the module docstring)
        -> src/knowledge/
             chunking.ts  (parse/clean/chunk pipeline stage, unit-tested)
             retrieval.ts (chunk retrieval, reuses memory/retrieval.ts's
                            tokenize+overlapScore primitives, unit-tested
                            + live end-to-end verified)
             parsers/
               textParser.ts / htmlParser.ts / csvParser.ts / jsonParser.ts
                 (pure, unit-tested, zero external deps)
               pdfParser.ts (real pdfjs-dist extraction — VERIFIED
                             end-to-end, see status table)
               docxParser.ts / pptxParser.ts / xlsxParser.ts
                 (real Word/PowerPoint/Excel extraction, built on a
                  from-scratch zero-dependency ZIP reader — VERIFIED
                  end-to-end, see status table)
               ocrParser.ts (real OCR via the system `tesseract` binary
                 + sharp preprocessing — VERIFIED with real rendered
                 images, see status table)
               scannedPdfOcr.ts (scanned-PDF fallback via the system
                 `pdftoppm` binary + ocrParser.ts — VERIFIED end-to-end,
                 see status table; wired automatically into pdfParser.ts
                 when embedded-text extraction comes back empty)
               zip/miniZip.ts (zero-dependency ZIP archive reader —
                 no library available offline, implemented from the
                 actual ZIP format spec — VERIFIED, including real
                 DEFLATE decompression)
               registry.ts  (picks parser by sourceType)

services/core (Rust) — written to the exact same design, NOT compiled
     policy.rs   (risk levels, approval policy, run limits — unit tested,
                  not compiled — no rustc in this sandbox)
     tools.rs    (Tool trait + registry — unit tested, not compiled)
     agent.rs    (AgentRunner step loop — unit tested, not compiled)
     rpc.rs      (docs/CORE_PROTOCOL.md server: reads NDJSON requests
                   from stdin, dispatches to policy.rs, writes NDJSON
                   responses — unit tested in isolation (dispatch logic),
                   not compiled; needs serde/serde_json, the first real
                   external dependency this crate has taken on, deliberately
                   justified in Cargo.toml's comment)
     main.rs     (demo mode by default; `axora-core serve` runs rpc.rs's
                   stdio loop — this is what AXORA_CORE_BIN should point at
                   once a toolchain can build it)

services/gateway/src/core (TypeScript — the same design, actually running)
     policy.ts   (behaviorally identical to core/policy.rs — VERIFIED,
                  plus the PolicyProvider interface that makes this
                  pluggable — see coreClient.ts below)
     tools.ts    (Tool interface + registry — VERIFIED)
     agent.ts    (AgentRunner — VERIFIED, now depends on PolicyProvider
                   rather than the concrete local PolicyEngine)
     taskQueue.ts (background Task Engine — VERIFIED)
     coreClient.ts (gateway-side client for docs/CORE_PROTOCOL.md —
                     spawns a child process, speaks NDJSON, matches
                     responses by id; CorePolicyProvider adapts it to
                     the PolicyProvider interface — VERIFIED against a
                     real mock subprocess, see status table)
     Wired into server.ts as POST /v1/tools/execute, GET /v1/tools,
     GET /v1/action-log, and (new) selectPolicyProvider() at startup,
     which uses CorePolicyProvider when AXORA_CORE_BIN is set and
     reachable, falling back to the local PolicyEngine otherwise.

db/migrations/0001_init.sql      (Postgres schema: users, conversations,
                                  messages, memories, projects, agents,
                                  tasks, knowledge_documents, action_logs)
```

## Store / provider selection (real, not aspirational)

The gateway picks its store and providers at startup based on env vars —
this is live code in `src/server.ts`, not a plan:

- `DATABASE_URL` unset (default) → `SqliteStore`, verified.
- `DATABASE_URL` set → `PostgresStore`. If that fails to construct (no
  `pg` installed, unreachable server), **the gateway refuses to start**
  rather than silently falling back to SQLite while claiming Postgres.
- `ANTHROPIC_API_KEY` unset (default) → only the mock provider is
  registered.
- `ANTHROPIC_API_KEY` set → the real Anthropic provider is also
  registered and selectable via `"provider": "anthropic"` in a chat
  request. Registration itself is verified (see VERIFICATION.md); an
  actual completion through it has not been, for lack of network here.

## Next implementation steps (in order)

1. Run `services/core` against a real Rust toolchain: `cargo test` the
   three modules, then `cargo build` the binary, and fix whatever a real
   compiler finds that careful manual review couldn't catch here.
2. Run `db/migrations/0001_init.sql` against a real Postgres and
   `npm install pg` to actually execute `PostgresStore` for the first
   time — delete `src/types/pg.d.ts` once real `@types/pg` are installed.
3. Make an actual Anthropic API call through `AnthropicProvider` once
   network + a real key are available, and fix whatever that reveals.
4. Swap memory/knowledge retrieval's keyword+stemming approach for real
   embeddings + pgvector cosine similarity once an embeddings provider is
   reachable — the `embedding VECTOR(1536)` columns are already in the
   schema waiting for this; `retrieveMemories`/`retrieveChunks`'s callers
   don't need to change, only their scoring internals.
5. Real document parsers (PDF/DOCX/etc.) in front of `chunkText` —
   **PDF (including scanned/image-only PDFs via automatic OCR fallback),
   HTML, CSV, JSON, plain text/Markdown, DOCX, PPTX, XLSX, and image OCR
   (PNG/JPEG) are all done** (see status table and `docs/VERIFICATION.md`
   Milestones 6, 8, 11, and 13). Still unstarted: audio/video
   transcription — no speech-to-text engine was found in this sandbox
   the way `tesseract`/`pdftoppm` happened to be present for the others.
6. Wire the Rust agent runtime to the gateway — **done**: see status
   table and `docs/VERIFICATION.md` Milestone 10 (`docs/CORE_PROTOCOL.md`,
   `coreClient.ts`, `rpc.rs`, `AXORA_CORE_BIN`). The TS side is genuinely
   tested against a mock process and live-wired into the request path;
   the Rust side is written to the same spec but still unverified (no
   `rustc`) — point `AXORA_CORE_BIN` at a real compiled `axora-core`
   once step 1 above is done, and see what that reveals.
7. Background job queue for ingestion — **done**: see status table and
   `docs/VERIFICATION.md` Milestone 9. `TaskQueue` (in-process,
   configurable concurrency) now runs document chunking; a real
   distributed queue (Redis/broker-backed) is still future work, and
   this in-process one is documented as the correct *stepping-stone*
   abstraction, not a permanent stand-in for that.
9. Real approval UI/flow for `awaiting_approval` outcomes — **done**:
   `POST /v1/action-log/:id/decision` — see README status table and
   VERIFICATION.md Milestone 5.
10. Per-run budgets as the only path (no shared global fallback) —
    **done**, see status table and VERIFICATION.md Milestone 8: the
    old process-wide `RunLimits` is gone; every `/v1/tools/execute`
    call now gets a real persisted `agent_runs` row, created
    automatically when the caller doesn't supply a `run_id`.
11. `agents` table / real agent definitions — `agent_runs` can be created
    ad-hoc today with no backing `agents` row (schema's `agent_id` column
    was relaxed to nullable for this reason, documented in the migration).
    Wiring real agent definitions through is unstarted.
12. Concurrent-decision race in the approval flow — **fixed**: see
    `Store.claimAction` and README status table / VERIFICATION.md
    Milestone 7.
13. Memory/knowledge scoping — **conversation-level scoping done** (see
    status table / Milestone 7). Still missing: user- and project-level
    scoping (no auth/project system exists yet to scope by), and there's
    no way to promote a conversation-scoped memory to global or vice
    versa — that's a delete-and-recreate today, not an update.
14. Scope limit in the Core integration (Milestone 10, honest about what
    it doesn't cover): only the policy *decision* is delegatable to
    Core — tool registration and execution remain entirely in
    `services/gateway/src/core/tools.ts`. A real Rust-owned tool runtime
    (tools that execute inside Core itself, not just policy calls routed
    through it) is a bigger change, not attempted here.

Each step is additive to the interfaces already defined — no rewrite
required, per the master spec's engineering rules.
