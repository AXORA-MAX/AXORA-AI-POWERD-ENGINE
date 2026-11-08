import type { DocumentParser } from "./types.js";
import { textParser } from "./textParser.js";
import { htmlParser } from "./htmlParser.js";
import { csvParser } from "./csvParser.js";
import { jsonParser } from "./jsonParser.js";
import { pdfParser } from "./pdfParser.js";
import { docxParser } from "./docxParser.js";
import { pptxParser } from "./pptxParser.js";
import { xlsxParser } from "./xlsxParser.js";
import { ocrParser } from "./ocrParser.js";

const PARSERS: DocumentParser[] = [
  textParser,
  htmlParser,
  csvParser,
  jsonParser,
  pdfParser,
  docxParser,
  pptxParser,
  xlsxParser,
  ocrParser,
];

export function getParser(sourceType: string): DocumentParser | undefined {
  const normalized = sourceType.toLowerCase().trim();
  return PARSERS.find((p) => p.sourceTypes.includes(normalized));
}

export function supportedSourceTypes(): string[] {
  return PARSERS.flatMap((p) => p.sourceTypes);
}
