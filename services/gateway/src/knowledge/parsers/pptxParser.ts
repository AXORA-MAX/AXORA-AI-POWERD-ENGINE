import type { DocumentParser } from "./types.js";
import { readZipEntries } from "./zip/miniZip.js";
import { decodeHtmlEntities } from "./htmlParser.js";

/**
 * A .pptx file is a ZIP archive with one XML part per slide under
 * ppt/slides/slideN.xml. Text runs live in DrawingML <a:t> elements.
 * Slides are extracted in numeric order (not ZIP entry order, which
 * isn't guaranteed to match slide order) and separated with a heading
 * so retrieval can still tell which slide a chunk came from even after
 * chunking.ts's paragraph-based splitting.
 */

function slideNumber(entryName: string): number | null {
  const match = entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
  return match ? parseInt(match[1], 10) : null;
}

export function extractSlideText(slideXml: string): string {
  const runs = [...slideXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
  return decodeHtmlEntities(runs.map((m) => m[1]).join(" ")).trim();
}

export const pptxParser: DocumentParser = {
  sourceTypes: ["pptx"],
  async parse(input: Buffer): Promise<string> {
    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(input);
    } catch (err) {
      throw new Error(`Not a valid .pptx file (not a readable ZIP archive): ${String(err)}`);
    }

    const slideEntries = [...entries.entries()]
      .map(([name, data]) => ({ name, data, num: slideNumber(name) }))
      .filter((e): e is { name: string; data: Buffer; num: number } => e.num !== null)
      .sort((a, b) => a.num - b.num);

    if (slideEntries.length === 0) {
      throw new Error("Not a valid .pptx file: no ppt/slides/slideN.xml entries found");
    }

    return slideEntries
      .map((s) => {
        const text = extractSlideText(s.data.toString("utf8"));
        return `--- Slide ${s.num} ---\n${text}`;
      })
      .filter((s) => s.length > 0)
      .join("\n\n");
  },
};
