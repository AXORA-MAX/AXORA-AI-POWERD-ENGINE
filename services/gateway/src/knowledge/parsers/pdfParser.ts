import type { DocumentParser } from "./types.js";
import { rasterizeAndOcrPdf } from "./scannedPdfOcr.js";

/**
 * Real PDF text extraction via pdfjs-dist (Mozilla's PDF.js, the same
 * engine Firefox uses). Dynamically imported — same pattern as
 * AnthropicProvider/PostgresStore — so a gateway without this package
 * installed still starts; only PDF ingestion is unavailable, reported as
 * a clear error rather than silently returning empty/fake text.
 *
 * This one IS actually verified end-to-end in this sandbox (unusual —
 * most things here aren't, for lack of network): pdfjs-dist happens to
 * already be present. See pdfParser.test.ts, which builds a real PDF
 * with pdf-lib and extracts its text back out with this exact module.
 *
 * Scanned-PDF fallback (closes the gap flagged in Milestone 11): a PDF
 * with no embedded text layer — just scanned page images — correctly
 * extracts to empty text via pdfjs-dist, since there's genuinely no text
 * to extract. When that happens, this falls back to rasterizing each
 * page and running real OCR on it (scannedPdfOcr.ts) rather than just
 * returning empty. If OCR itself isn't available either (missing
 * tesseract/pdftoppm), the real error from that path propagates instead
 * of being swallowed into a silent empty result.
 */
export const pdfParser: DocumentParser = {
  sourceTypes: ["pdf"],
  async parse(input: Buffer): Promise<string> {
    let pdfjsLib: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
    try {
      pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    } catch (err) {
      throw new Error(
        "PDF parsing requires the 'pdfjs-dist' package, which is not installed. " +
          `Run 'npm install pdfjs-dist' in services/gateway. (${String(err)})`,
      );
    }

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(input),
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ");
      pageTexts.push(pageText);
    }

    await pdf.destroy();
    const extractedText = pageTexts.join("\n\n");

    if (extractedText.trim().length === 0) {
      return rasterizeAndOcrPdf(input);
    }
    return extractedText;
  },
};
