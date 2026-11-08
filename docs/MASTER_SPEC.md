# AXORA — Master Specification (source of truth)

This file is the canonical long-term architecture/vision doc for AXORA,
copied into the repo so implementation decisions can be traced back to it.
See `README.md` for the actual current implementation status, and
`docs/ROADMAP.md` for phase tracking.

Key excerpts guiding current implementation:

- Identity: Personal AI + AI OS + Agent Platform + Developer Platform.
  Motto: "AXORA: Your Mind, Amplified. 🚀"
- Stack: Rust (Core/orchestration/security-critical), Python (AI/ML/RAG),
  TypeScript (API Gateway/SDKs/platform services), React/Next.js (web),
  React Native (mobile), PostgreSQL + pgvector (data/vector).
- Architecture: User -> AXORA UI -> API Gateway -> AXORA Core ->
  Model Router / Memory / Knowledge / Agent Runtime / Tool System /
  Policy Engine -> AI Models / Local Models / External Services.
- Hard rules: never fake a search/tool call/action; never expose secrets to
  the frontend; dangerous/high-impact tool actions require explicit
  approval; treat all external content as untrusted; prefer modular,
  replaceable, testable architecture over speed.

The full spec text is long (agents, multi-agent, tools, connectors,
marketplace, knowledge graph, voice, vision, etc.) and is tracked in project
memory / the original spec documents rather than duplicated here in full.
