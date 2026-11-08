# AXORA — Project Master Index

**This is the single consolidated reference for the whole project.**
Everything built across every prior delivery (`axora-phase1.zip` through
`axora-phase15.zip`, plus this session's Secret Vault work) is in this
one repository, under this one file as the index. You do not need to
look at the old phase zips separately — this is all of it, current as
of this file's last update.

This document does not claim the project is "finished." The original
10-phase master specification describes a full AI-platform product on
the scale of a real company's multi-year roadmap. What follows is an
honest accounting of what fraction of that is actually built, actually
verified, and what remains — organized so you can see the whole picture
in one place instead of across 17 separate milestone writeups.

---

## 1. Status against the original 10-phase spec

| # | Spec Phase | Status | Detail |
|---|---|---|---|
| 1 | Foundation | 🟢 Mostly done | Repo structure, API gateway, DB schema (Postgres + SQLite), config, structured logging, body-size limits, rate limiting |
| 2 | AXORA Core | 🟡 Partial | TypeScript policy/tool/agent runtime real and tested; Rust `services/core` written + manually audited but **never compiled** (no Rust toolchain in this sandbox); gateway↔Core protocol built and tested against a mock process |
| 3 | User Experience | 🟡 Partial | Real multi-view web UI (Milestone 18): chat with streaming + conversation history replay, memory manager, Knowledge Vault with real file upload, tools & action-log with working Approve/Reject. Not built: projects view, settings screens, mobile/responsive layout, a Next.js/React production frontend (not installable offline here) |
| 4 | Memory & Knowledge | 🟢 Mostly done | Memory CRUD + conversation scoping; Knowledge Vault with real parsers (PDF, DOCX, PPTX, XLSX, HTML, CSV, JSON, image OCR, scanned-PDF OCR fallback); background ingestion queue |
| 5 | Multimodal AI | 🟡 Partial | Real OCR/image text extraction done; no voice, no video understanding, no image/video generation |
| 6 | Agents | 🟡 Partial | Single-agent tool loop, risk-based policy/approval, per-run budgets, approval-resume flow, Secret Vault for credentials — all real and tested; no multi-agent coordination, no agent builder UI, no agent marketplace |
| 7 | Research & Web | 🔴 Not started | No web search integration (no network access in this sandbox to build/test against a real search API) |
| 8 | Coding & Computer Use | 🔴 Not started | No code execution sandbox, no browser automation |
| 9 | Developer Platform | 🔴 Not started | No public API docs site, no SDKs, no developer console |
| 10 | AXORA Store & Ecosystem | 🔴 Not started | No marketplace |

🟢 = substantially built and verified · 🟡 = real but partial · 🔴 = not started

**Honest summary**: roughly 2 of 10 phases are in solid shape, 4 are
genuinely partial, 4 haven't been started. This is not going to reach
"10/10 done" inside this sandbox — phases 7–10 specifically need things
this environment doesn't have (network access, a real deployment
target, a multi-week+ engineering effort). What's described below is
real, working, and tested as far as it goes.

---

## 2. What's actually built and verified (by subsystem)

Everything in this section has been **compiled, unit-tested, and
exercised live over real HTTP** in this sandbox — not just written. See
`docs/VERIFICATION.md` for the full, detailed record (18 milestones) of
exactly what was run and what the results were, including every real
bug that was found and how it was fixed.

- **Gateway core** (`services/gateway`) — TypeScript, Node.js, zero
  required runtime dependencies for the base path (SQLite + mock
  provider). Real HTTP server, SSE streaming chat, conversation
  persistence.
- **Model Router + Providers** — pluggable `ModelProvider` interface;
  offline `MockProvider` (verified) and a real `AnthropicProvider`
  (written correctly, network-call itself unverified — no egress here).
- **Memory system** — long-term memory with keyword+stemming retrieval,
  conversation-level scoping (a memory can be private to one
  conversation or global).
- **Knowledge Vault** — document ingestion with **real** parsers for
  PDF (pdfjs-dist), DOCX/PPTX/XLSX (hand-written zero-dependency ZIP
  reader + OOXML parsing), HTML, CSV, JSON, plain text, and **real
  OCR** (system `tesseract` + `sharp` preprocessing) for images and
  scanned/image-only PDFs (via `pdftoppm` rasterization). All parsers
  tested against real generated fixtures, several live-tested through
  the actual HTTP upload endpoint.
- **Background Task Engine** (`TaskQueue`) — real concurrency-limited
  async queue; document parsing *and* chunking both run on it, so slow
  operations (OCR) don't block the HTTP response (measured: 10ms
  response time for a scanned-PDF upload that requires real OCR).
- **Tool System + Policy Engine + Agent Runner** — risk-based
  (low/medium/high/dangerous) approval policy, real tool registry,
  dangerous actions correctly halt awaiting human approval and provably
  never execute without it, approval-resume flow, atomic
  concurrent-decision handling (verified under genuine concurrent HTTP
  load), per-run step/delegation budgets persisted to the database.
- **Gateway ↔ Core integration boundary** — a specified NDJSON protocol
  (`docs/CORE_PROTOCOL.md`) letting the gateway delegate policy
  decisions to a separate Rust process; the TypeScript client side is
  genuinely tested against a real mock subprocess and live-wired into
  the request path with automatic fallback if the Core process is
  unavailable.
- **Security**: request body size limits (DoS protection), rate
  limiting (real token-bucket, verified under concurrent load), and a
  **Secret Vault** (real AES-256-GCM authenticated encryption, access
  auditing, revocation — this session's work).
- **Web UI** (`apps/web/public/index.html`) — dependency-free
  multi-view app: streaming chat with real conversation-history
  replay, memory manager, Knowledge Vault with real browser file
  upload, tools & action-log with working Approve/Reject buttons.
  Tested end-to-end with Playwright against the real running gateway.
- **Rust `services/core`** — policy/tool/agent runtime and the Core
  protocol server, written to mirror the TypeScript design exactly and
  rigorously manually audited (borrow-checker/lifetime reasoning traced
  by hand) — but **never compiled**, because no Rust toolchain has been
  reachable in this sandbox in any session so far.

### Real bugs found and fixed along the way (not hidden)

This project's working method has been: build it, test it for real,
and when a test or a live HTTP call reveals a bug, fix it and record
it — never just assert something works. Some notable ones:
- A background task queue that started work synchronously instead of
  deferring it, defeating its own purpose (Milestone 9).
- A connection-killing bug where rejecting an oversized request body
  also destroyed the TCP connection before the error response could be
  sent (Milestone 15).
- A rate-limiter cleanup function that checked a stale, lazily-updated
  field and would have evicted almost nothing in practice (Milestone
  16).
- Two sandbox/shell issues (not app bugs) while stress-testing the rate
  limiter under concurrency, both diagnosed and worked around
  (Milestone 16 follow-up).

Full details of every one of these are in `docs/VERIFICATION.md`.

---

## 3. What's explicitly NOT built, and why

| Gap | Why |
|---|---|
| Projects view, settings screens, responsive/mobile layout, a Next.js production frontend | The web UI (Milestone 18) covers chat/memory/knowledge/tools only; Next.js isn't installable offline here |
| Web search / Research mode | No network egress in this sandbox to build or test against a real search API |
| Code execution sandbox | Not started |
| Browser/computer automation | Not started |
| Multi-agent coordination | Only single-agent tool loops exist |
| Developer Platform (public API docs, SDKs) | Not started |
| AXORA Store / marketplace | Not started |
| Voice, video understanding/generation | No engine available for these in this sandbox |
| `services/core` (Rust) actually compiled | No `rustc`/`cargo` reachable in this sandbox, in any session, confirmed repeatedly |
| `PostgresStore` actually executed | No Postgres server in this sandbox — SQL written and reviewed, never run |
| Key rotation automation for the Secret Vault | Mismatch detection works; bulk re-encryption under a new key isn't automated yet |

---

## 4. How to actually run this

See `README.md` for full instructions. Quick version:

```bash
cd services/gateway
npm install            # pulls in pg, pdfjs-dist, sharp (all optional —
                        # the gateway runs without any of them via the
                        # SQLite store + mock provider)
npm run build
npm start               # http://localhost:8787
```

Open `apps/web/public/index.html` in a browser for the real web UI
(chat, memory, Knowledge Vault upload, tools & actions with approval
buttons) against the running gateway.

---

## 5. Where to go for more detail

- `README.md` — architecture overview, per-component verification
  status table, environment/dependency notes.
- `docs/VERIFICATION.md` — the full, chronological record of all 18
  milestones: what was built, what was actually run, what passed, what
  failed and was fixed, and what remains unverified and why.
- `docs/CORE_PROTOCOL.md` — the gateway↔Core wire protocol spec.
- `docs/MASTER_SPEC.md` — the original 10-phase product specification
  this whole project is measured against.

---

*This file is the living index — updated each time a new subsystem is
built, not a one-time snapshot. "Master" here means "the one place that
has everything," not "finished."*
