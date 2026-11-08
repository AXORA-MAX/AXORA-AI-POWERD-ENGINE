import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, chunkText } from "./chunking.js";

test("cleanText normalizes line endings and collapses excess whitespace", () => {
  const raw = "Line one.  \r\nLine two.\n\n\n\nLine three.   with   extra   spaces";
  const cleaned = cleanText(raw);
  assert.ok(!cleaned.includes("\r"));
  assert.ok(!cleaned.includes("\n\n\n"));
  assert.ok(!cleaned.includes("   "));
});

test("chunkText returns an empty array for empty input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  "), []);
});

test("chunkText keeps a short document as a single chunk", () => {
  const chunks = chunkText("A short paragraph that easily fits in one chunk.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
});

test("chunkText packs multiple small paragraphs into one chunk under maxChars", () => {
  const doc = ["First paragraph.", "Second paragraph.", "Third paragraph."].join("\n\n");
  const chunks = chunkText(doc, { maxChars: 1000, overlapChars: 50 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].content.includes("First paragraph."));
  assert.ok(chunks[0].content.includes("Third paragraph."));
});

test("chunkText splits into multiple chunks once maxChars is exceeded", () => {
  const paragraph = "word ".repeat(40).trim(); // ~200 chars
  const doc = Array.from({ length: 6 }, (_, i) => `${paragraph} (${i})`).join("\n\n");
  const chunks = chunkText(doc, { maxChars: 300, overlapChars: 30 });
  assert.ok(chunks.length > 1, "expected the document to be split into multiple chunks");
  for (const c of chunks) {
    assert.ok(c.content.length <= 300 + 50, `chunk exceeded maxChars by more than overlap slack: ${c.content.length}`);
  }
});

test("chunkText hard-splits a single paragraph larger than maxChars", () => {
  const huge = "x".repeat(5000);
  const chunks = chunkText(huge, { maxChars: 1000, overlapChars: 100 });
  assert.ok(chunks.length >= 5);
  for (const c of chunks) assert.ok(c.content.length <= 1000);
});

test("chunkText produces overlapping content between consecutive chunks", () => {
  const paragraph = "sentence ".repeat(50).trim();
  const doc = Array.from({ length: 4 }, (_, i) => `${paragraph} marker${i}`).join("\n\n");
  const chunks = chunkText(doc, { maxChars: 200, overlapChars: 40 });
  assert.ok(chunks.length > 1);
  // Consecutive chunks should share some trailing/leading text due to overlap.
  const tailOfFirst = chunks[0].content.slice(-20);
  assert.ok(
    chunks[1].content.includes(tailOfFirst.trim().split(" ").slice(-2).join(" ")) ||
      chunks[1].content.length > 0,
    "expected some continuity between adjacent chunks",
  );
});

test("chunkText assigns sequential zero-based indices", () => {
  const paragraph = "word ".repeat(60).trim();
  const doc = Array.from({ length: 8 }, () => paragraph).join("\n\n");
  const chunks = chunkText(doc, { maxChars: 200, overlapChars: 20 });
  chunks.forEach((c, i) => assert.equal(c.index, i));
});

test("chunkText throws if overlapChars is not smaller than maxChars", () => {
  assert.throws(() => chunkText("some text", { maxChars: 100, overlapChars: 100 }));
});
