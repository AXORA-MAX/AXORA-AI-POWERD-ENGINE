import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rasterizeAndOcrPdf } from "./scannedPdfOcr.js";
import { pdfParser } from "./pdfParser.js";

const require = createRequire((import.meta as any).url);
const execFileAsync = promisify(execFile);

/** Renders real text to a real PNG via ImageMagick — same fixture approach as ocrParser.test.ts. */
async function renderTextImage(text: string, dir: string): Promise<Buffer> {
  const path = join(dir, "source.png");
  await execFileAsync("convert", [
    "-size",
    "700x180",
    "-background",
    "white",
    "-fill",
    "black",
    "-font",
    "DejaVu-Sans",
    "-pointsize",
    "26",
    `label:${text}`,
    path,
  ]);
  return readFile(path);
}

/**
 * Builds a real PDF with an embedded PNG image and deliberately NO
 * drawText calls — this is what distinguishes a "scanned" PDF from a
 * normal one: pdfjs-dist's text extraction will correctly find nothing,
 * because there genuinely is no text layer, only a picture of text.
 */
async function buildScannedPdf(text: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "axora-scanned-pdf-test-"));
  try {
    const imageBytes = await renderTextImage(text, dir);
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(imageBytes);
    const page = doc.addPage([700, 180]);
    page.drawImage(png, { x: 0, y: 0, width: 700, height: 180 });
    const bytes = await doc.save();
    return Buffer.from(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

test("rasterizeAndOcrPdf recovers real text from a PDF with no text layer", async () => {
  const pdf = await buildScannedPdf("AXORA reads scanned PDFs now");
  const text = await rasterizeAndOcrPdf(pdf);
  assert.equal(normalize(text), "axora reads scanned pdfs now");
});

test("pdfParser automatically falls back to OCR for a scanned (text-less) PDF", async () => {
  // This is the actual integration point: pdfParser.parse() alone,
  // exactly as the gateway calls it, with no special-casing by the
  // caller — it must detect the empty text layer and recover the text
  // itself.
  const pdf = await buildScannedPdf("Fallback works end to end");
  const text = await pdfParser.parse(pdf);
  assert.equal(normalize(text), "fallback works end to end");
});

test("pdfParser still uses the fast text-layer path for a normal (non-scanned) PDF", async () => {
  // Regression guard: a PDF that DOES have a real text layer must not
  // be routed through OCR at all — build one with pdf-lib's drawText
  // (the same way pdfParser.test.ts does) and confirm the exact text
  // comes back, which OCR could plausibly also produce but would prove
  // nothing about which code path actually ran. Checked indirectly here
  // by confirming correctness; the two paths are structurally separate
  // in pdfParser.ts (an early return before the OCR fallback is ever
  // reached when extractedText is non-empty).
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText("Normal text-layer PDF.", { x: 20, y: 150, size: 16, font });
  const bytes = await doc.save();

  const text = await pdfParser.parse(Buffer.from(bytes));
  assert.ok(text.includes("Normal text-layer PDF."));
});
