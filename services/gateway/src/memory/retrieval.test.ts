import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, stem, scoreMemory, retrieveMemories } from "./retrieval.js";
import type { StoredMemory } from "../types.js";

function mem(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: "m1",
    category: "fact",
    content: "the user prefers dark mode",
    source: "chat",
    confidence: 1,
    importance: 0.5,
    conversation_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test("tokenize strips punctuation, lowercases, drops stopwords and single-char tokens", () => {
  // "AXORA's" splits into "axora" + "s" once the apostrophe is stripped;
  // the trailing "s" is dropped by the length > 1 filter, which is
  // correct behavior (a bare "s" carries no retrieval signal) — this
  // test was initially written expecting "s" to survive, which was
  // wrong; fixed to match the (correct) implementation.
  assert.deepEqual(
    tokenize("What is AXORA's Model Router?"),
    ["axora", "model", "router"],
  );
});

test("scoreMemory returns 0 for a memory with no token overlap", () => {
  const q = new Set(tokenize("what is the weather today"));
  const score = scoreMemory(q, mem({ content: "the user prefers dark mode" }));
  assert.equal(score, 0);
});

test("scoreMemory returns a positive score proportional to overlap", () => {
  const q = new Set(tokenize("what theme does the user prefer"));
  const score = scoreMemory(q, mem({ content: "the user prefers dark mode" }));
  assert.ok(score > 0, "expected a positive relevance score");
});

test("retrieveMemories excludes zero-relevance memories entirely", () => {
  const memories = [
    mem({ id: "a", content: "the user prefers dark mode" }),
    mem({ id: "b", content: "the user's favorite language is rust" }),
  ];
  const results = retrieveMemories("what programming language do they like", memories);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "b");
});

test("retrieveMemories ranks higher-overlap memories first", () => {
  const memories = [
    mem({ id: "low", content: "the user likes coffee" }),
    mem({ id: "high", content: "the user likes coffee in the morning before coding" }),
  ];
  const results = retrieveMemories("does the user like coffee in the morning", memories);
  assert.equal(results[0].id, "high");
});

test("stem closes the singular/plural gap that broke real retrieval (prefer vs prefers)", () => {
  assert.equal(stem("prefers"), stem("prefer"));
});

test("retrieveMemories finds a memory even when the query uses a different inflection", () => {
  // Regression test: this exact case (query "prefer", stored "prefers")
  // returned zero results before `stem` was added — caught via the live
  // gateway smoke test, not written speculatively.
  const memories = [mem({ id: "a", content: "the user prefers dark mode and concise answers" })];
  const results = retrieveMemories("what theme do I prefer?", memories);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "a");
});

test("retrieveMemories respects topK", () => {
  const memories = Array.from({ length: 10 }, (_, i) =>
    mem({ id: `m${i}`, content: `fact number ${i} about rust programming` }),
  );
  const results = retrieveMemories("rust programming fact", memories, 3);
  assert.equal(results.length, 3);
});
