import type { DocumentParser } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

/**
 * Real OCR via the system `tesseract` binary — not an npm package (no
 * pure-JS OCR engine worth trusting is installable offline either; the
 * actual Tesseract engine, via its CLI, happens to already be present in
 * this sandbox). This is a genuine external system dependency, not
 * bundled with the gateway: if `tesseract` isn't on PATH wherever this
 * runs, this throws a clear error rather than silently returning empty
 * text — the same "no fake capabilities" rule every other parser here
 * follows.
 *
 * Preprocessing via `sharp` (grayscale + normalize) before handing the
 * image to tesseract is a real, standard accuracy improvement for OCR,
 * not decoration — tesseract's own documentation recommends exactly
 * this kind of preprocessing for noisy/low-contrast source images.
 *
 * Scope: single image in, plain text out. No layout/table reconstruction,
 * no multi-language detection (English only, via `-l eng`), no PDF
 * rasterization (a scanned PDF needs its pages rasterized to images
 * first — that's a real gap, not covered here; pdfParser.ts only
 * extracts embedded text, so a scanned/image-only PDF currently
 * produces no text through either parser).
 */

async function runTesseract(imagePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng"]);
    return stdout.trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        "OCR requires the 'tesseract' system binary, which was not found on PATH. " +
          "Install it (e.g. `apt-get install tesseract-ocr`) — this is a system " +
          "dependency, not an npm package.",
      );
    }
    throw new Error(`tesseract OCR failed: ${err?.stderr || err?.message || String(err)}`);
  }
}

async function preprocessImage(input: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(input).grayscale().normalize().toFormat("png").toBuffer();
}

export const ocrParser: DocumentParser = {
  sourceTypes: ["png", "jpg", "jpeg"],
  async parse(input: Buffer): Promise<string> {
    let preprocessed: Buffer;
    try {
      preprocessed = await preprocessImage(input);
    } catch (err) {
      // sharp missing/broken, or genuinely not a decodable image —
      // report it rather than silently OCRing raw bytes that aren't a
      // valid image (which would just produce garbage, not an honest
      // failure).
      throw new Error(`OCR preprocessing failed (image may be corrupt or unsupported): ${String(err)}`);
    }

    const dir = await mkdtemp(join(tmpdir(), "axora-ocr-"));
    const imagePath = join(dir, `${randomUUID()}.png`);
    try {
      await writeFile(imagePath, preprocessed);
      return await runTesseract(imagePath);
    } finally {
      // Removes the whole temp directory (not just the file) so no
      // empty axora-ocr-* dirs accumulate in the OS tmpdir over time.
      await rm(dir, { recursive: true, force: true });
    }
  },
};
