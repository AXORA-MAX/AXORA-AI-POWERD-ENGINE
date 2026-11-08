import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveChunks } from "./retrieval.js";
import type { StoredKnowledgeChunk } from "../types.js";

function chunk(
  overrides: Partial<StoredKnowledgeChunk & { document_title: string }> = {},
): StoredKnowledgeChunk & { document_title: string } {
  return {
    id: "c1",
    document_id: "d1",
    document_title: "AXORA Architecture Notes",
    chunk_index: 0,
    content: "The model router selects a provider based on task mode.",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test("retrieveChunks excludes chunks with no keyword overlap", () => {
  const chunks = [chunk({ content: "The weather today is sunny and warm." })];
  const results = retrieveChunks("how does the model router work", chunks);
  assert.equal(results.length, 0);
});

test("retrieveChunks finds and ranks a relevant chunk", () => {
  const chunks = [
    chunk({ id: "irrelevant", content: "The weather today is sunny." }),
    chunk({ id: "relevant", content: "The model router selects a provider based on task mode." }),
  ];
  const results = retrieveChunks("how does the model router pick a provider", chunks);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "relevant");
  assert.ok(results[0].score > 0);
});

test("retrieveChunks carries document_title through to results", () => {
  const chunks = [chunk({ document_title: "Router Design Doc" })];
  const results = retrieveChunks("model router", chunks);
  assert.equal(results[0].document_title, "Router Design Doc");
});

test("retrieveChunks respects topK across multiple relevant chunks", () => {
  const chunks = Array.from({ length: 10 }, (_, i) =>
    chunk({ id: `c${i}`, content: `Chunk ${i} discusses the model router and providers.` }),
  );
  const results = retrieveChunks("model router providers", chunks, 3);
  assert.equal(results.length, 3);
});
