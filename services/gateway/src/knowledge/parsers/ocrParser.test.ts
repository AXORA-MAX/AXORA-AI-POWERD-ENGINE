import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrParser } from "./ocrParser.js";

const execFileAsync = promisify(execFile);

/**
 * Renders real text into a real PNG using ImageMagick's `convert` — a
 * genuine system binary present in this sandbox, used here purely to
 * build test fixtures (same role pdf-lib plays for pdfParser.test.ts
 * and the hand-built ZIP writer plays for the Office-format tests): an
 * independent tool producing real input, not a hand-crafted string the
 * parser is tailored to match.
 */
async function renderTextImage(text: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "axora-ocr-test-"));
  const path = join(dir, "fixture.png");
  try {
    await execFileAsync("convert", [
      "-size",
      "600x160",
      "-background",
      "white",
      "-fill",
      "black",
      "-font",
      "DejaVu-Sans",
      "-pointsize",
      "28",
      `label:${text}`,
      path,
    ]);
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

test("ocrParser extracts real text from a real rendered image", async () => {
  const image = await renderTextImage("AXORA Knowledge Vault OCR test");
  const text = await ocrParser.parse(image);
  assert.equal(normalize(text), "axora knowledge vault ocr test");
});

test("ocrParser handles a different sentence correctly (not hardcoded to one fixture)", async () => {
  const image = await renderTextImage("The model router selects a provider");
  const text = await ocrParser.parse(image);
  assert.equal(normalize(text), "the model router selects a provider");
});

test("ocrParser throws a clear error on input that isn't a decodable image", async () => {
  await assert.rejects(
    () => ocrParser.parse(Buffer.from("this is plainly not an image")),
    /OCR preprocessing failed/,
  );
});

test("ocrParser cleans up its temp files (no leftover axora-ocr-* dirs after a successful run)", async () => {
  const image = await renderTextImage("cleanup check");
  await ocrParser.parse(image);

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(tmpdir());
  // Only axora-ocr-N dirs created by ocrParser.ts itself count here —
  // axora-ocr-test-N dirs are this test file's own fixture dirs, already
  // cleaned up by renderTextImage's own `finally`, but excluded
  // explicitly for clarity rather than relying on that.
  const leftovers = entries.filter((e) => e.startsWith("axora-ocr-") && !e.startsWith("axora-ocr-test-"));
  assert.equal(leftovers.length, 0, `expected no leftover temp dirs, found: ${leftovers.join(", ")}`);
});
