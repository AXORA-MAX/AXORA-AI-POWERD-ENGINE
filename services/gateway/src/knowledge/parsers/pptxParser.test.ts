import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSlideText, pptxParser } from "./pptxParser.js";
import { buildStoredZip } from "./zip/testFixtureZipWriter.js";

function slideXml(...texts: string[]): string {
  const runs = texts.map((t) => `<a:t>${t}</a:t>`).join("");
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

test("extractSlideText joins multiple text runs on a slide with spaces", () => {
  const text = extractSlideText(slideXml("AXORA", "Model Router"));
  assert.equal(text, "AXORA Model Router");
});

test("extractSlideText decodes entities", () => {
  const text = extractSlideText(slideXml("Providers &amp; Tools"));
  assert.equal(text, "Providers & Tools");
});

test("pptxParser orders slides numerically, not by ZIP entry order", async () => {
  // Deliberately inserted out of numeric order (10 before 2) to prove
  // the parser sorts by parsed slide number, not insertion/entry order.
  const zip = buildStoredZip({
    "ppt/slides/slide10.xml": slideXml("Last slide"),
    "ppt/slides/slide1.xml": slideXml("First slide"),
    "ppt/slides/slide2.xml": slideXml("Second slide"),
  });
  const text = await pptxParser.parse(zip);
  const firstIdx = text.indexOf("First slide");
  const secondIdx = text.indexOf("Second slide");
  const lastIdx = text.indexOf("Last slide");
  assert.ok(firstIdx < secondIdx && secondIdx < lastIdx, "slides must appear in numeric order 1, 2, 10");
});

test("pptxParser labels each slide so retrieval can tell them apart", async () => {
  const zip = buildStoredZip({ "ppt/slides/slide1.xml": slideXml("Only slide") });
  const text = await pptxParser.parse(zip);
  assert.ok(text.includes("Slide 1"));
  assert.ok(text.includes("Only slide"));
});

test("pptxParser throws a clear error when there are no slide entries", async () => {
  const zip = buildStoredZip({ "[Content_Types].xml": "<Types/>" });
  await assert.rejects(() => pptxParser.parse(zip), /no ppt\/slides/);
});
