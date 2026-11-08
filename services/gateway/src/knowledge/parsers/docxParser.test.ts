import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocxText, docxParser } from "./docxParser.js";
import { buildStoredZip } from "./zip/testFixtureZipWriter.js";

// A realistic (trimmed) word/document.xml body: two paragraphs, the
// second split across multiple <w:t> runs the way real Word output does
// when formatting changes mid-sentence (bold starts partway through).
const SAMPLE_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>AXORA Architecture Overview</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">The model router selects a </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>provider</w:t></w:r>
      <w:r><w:t xml:space="preserve"> based on task mode &amp; capability.</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t/></w:r></w:p>
  </w:body>
</w:document>`;

test("extractDocxText joins multiple runs within one paragraph into a single line", () => {
  const text = extractDocxText(SAMPLE_DOCUMENT_XML);
  assert.ok(text.includes("The model router selects a provider based on task mode & capability."));
});

test("extractDocxText separates paragraphs with blank lines", () => {
  const text = extractDocxText(SAMPLE_DOCUMENT_XML);
  const paragraphs = text.split("\n\n");
  assert.equal(paragraphs.length, 2); // the empty third paragraph is dropped
  assert.equal(paragraphs[0], "AXORA Architecture Overview");
});

test("extractDocxText drops empty paragraphs", () => {
  const text = extractDocxText(SAMPLE_DOCUMENT_XML);
  assert.ok(!text.includes("\n\n\n"));
});

test("docxParser end-to-end: real ZIP fixture in, correct extracted text out", async () => {
  const zip = buildStoredZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": SAMPLE_DOCUMENT_XML,
  });
  const text = await docxParser.parse(zip);
  assert.ok(text.includes("AXORA Architecture Overview"));
  assert.ok(text.includes("provider based on task mode & capability."));
});

test("docxParser throws a clear error when word/document.xml is missing", async () => {
  const zip = buildStoredZip({ "[Content_Types].xml": "<Types/>" });
  await assert.rejects(() => docxParser.parse(zip), /missing word\/document\.xml/);
});

test("docxParser throws a clear error on a non-ZIP input", async () => {
  await assert.rejects(() => docxParser.parse(Buffer.from("not a docx")), /not a readable ZIP archive/);
});
