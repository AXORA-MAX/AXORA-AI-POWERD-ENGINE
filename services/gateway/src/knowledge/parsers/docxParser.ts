import type { DocumentParser } from "./types.js";
import { readZipEntries } from "./zip/miniZip.js";
import { decodeHtmlEntities } from "./htmlParser.js";

/**
 * A .docx file is a ZIP archive containing OOXML parts; the document
 * body lives at word/document.xml as a sequence of <w:p> paragraphs,
 * each containing <w:t> text runs. This extracts paragraph text and
 * joins paragraphs with blank lines — matching exactly the paragraph
 * structure chunking.ts expects, rather than a flat tag-strip.
 */

/** Extract the concatenated <w:t> run text from one <w:p>...</w:p> XML block. */
function extractParagraphText(paragraphXml: string): string {
  const runs = [...paragraphXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
  return decodeHtmlEntities(runs.map((m) => m[1]).join(""));
}

export function extractDocxText(documentXml: string): string {
  const paragraphs = [...documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    extractParagraphText(m[0]),
  );
  return paragraphs.filter((p) => p.trim().length > 0).join("\n\n");
}

export const docxParser: DocumentParser = {
  sourceTypes: ["docx"],
  async parse(input: Buffer): Promise<string> {
    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(input);
    } catch (err) {
      throw new Error(`Not a valid .docx file (not a readable ZIP archive): ${String(err)}`);
    }

    const documentXml = entries.get("word/document.xml");
    if (!documentXml) {
      throw new Error("Not a valid .docx file: missing word/document.xml");
    }

    return extractDocxText(documentXml.toString("utf8"));
  },
};
