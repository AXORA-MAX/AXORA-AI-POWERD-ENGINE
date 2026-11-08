import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrParser } from "./ocrParser.js";

const execFileAsync = promisify(execFile);

/**
 * Closes the gap flagged in ocrParser.ts / docs/VERIFICATION.md
 * Milestone 11: a PDF that's just a stack of scanned page images has no
 * embedded text layer, so pdfParser.ts's pdfjs-dist extraction correctly
 * (not buggily) returns empty text for it. This module is the fallback:
 * rasterize each page to a real PNG via the system `pdftoppm` binary
 * (poppler-utils), then OCR each page with the already-verified
 * ocrParser.ts — no new OCR logic, just a new source of images for it.
 *
 * Like ocrParser.ts, this depends on a real system binary (`pdftoppm`,
 * part of poppler-utils) that isn't an npm package and isn't bundled —
 * a clear error is thrown if it's missing, never silent empty output.
 */

async function rasterizePdfPages(pdfBuffer: Buffer, dir: string): Promise<string[]> {
  const pdfPath = join(dir, "input.pdf");
  await writeFile(pdfPath, pdfBuffer);

  const prefix = join(dir, "page");
  try {
    // -r 150: 150 DPI, a reasonable balance of OCR accuracy vs. speed/size
    // for typical scanned-document resolutions.
    await execFileAsync("pdftoppm", ["-png", "-r", "150", pdfPath, prefix]);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        "Scanned-PDF OCR requires the 'pdftoppm' system binary (poppler-utils), " +
          "which was not found on PATH. Install it (e.g. `apt-get install poppler-utils`).",
      );
    }
    throw new Error(`pdftoppm failed to rasterize PDF pages: ${err?.stderr || err?.message || String(err)}`);
  }

  const entries = await readdir(dir);
  // poppler names output "page-1.png", "page-2.png", ... (or zero-padded
  // for >9 pages, e.g. "page-01.png") — sort numerically by the number
  // in the filename, not lexically, so page 10 doesn't sort before page 2.
  const pageFiles = entries
    .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
    .map((f) => ({ file: f, num: parseInt(f.slice("page-".length, -".png".length), 10) }))
    .filter((f) => Number.isFinite(f.num))
    .sort((a, b) => a.num - b.num);

  if (pageFiles.length === 0) {
    throw new Error("pdftoppm produced no page images — the PDF may be empty or corrupt");
  }

  return pageFiles.map((f) => join(dir, f.file));
}

/** Rasterizes every page of a PDF and OCRs each one, joining the results in page order. */
export async function rasterizeAndOcrPdf(pdfBuffer: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "axora-pdf-ocr-"));
  try {
    const pagePaths = await rasterizePdfPages(pdfBuffer, dir);
    const pageTexts: string[] = [];
    for (const pagePath of pagePaths) {
      const imageBytes = await readFile(pagePath);
      const text = await ocrParser.parse(imageBytes);
      pageTexts.push(text);
    }
    return pageTexts.filter((t) => t.trim().length > 0).join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
