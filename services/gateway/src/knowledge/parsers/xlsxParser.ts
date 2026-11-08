import type { DocumentParser } from "./types.js";
import { readZipEntries } from "./zip/miniZip.js";
import { decodeHtmlEntities } from "./htmlParser.js";

/**
 * A .xlsx file is a ZIP archive: xl/sharedStrings.xml holds a
 * deduplicated string table, and xl/worksheets/sheetN.xml holds cells
 * that either reference a shared string by index (t="s", <v> = index)
 * or carry an inline/numeric value directly. Scope: reads the *first*
 * worksheet only (xl/worksheets/sheet1.xml) — multi-sheet workbooks
 * need xl/workbook.xml's sheet-name mapping to do properly, which is a
 * real gap, documented rather than silently only handling one sheet
 * without saying so.
 */

/** Parse xl/sharedStrings.xml into an index -> string array. */
export function parseSharedStrings(xml: string): string[] {
  // Each <si> (shared string item) can contain a plain <t> or multiple
  // <r><t> runs (rich text) — concatenate all <t> content within each <si>.
  const items = [...xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)];
  return items.map((si) => {
    const runs = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)];
    return decodeHtmlEntities(runs.map((r) => r[1]).join(""));
  });
}

interface Cell {
  ref: string; // e.g. "B3"
  value: string;
}

function columnLetters(ref: string): string {
  return ref.match(/^[A-Z]+/)?.[0] ?? ref;
}

/** Parse one worksheet XML into rows of resolved cell values, in column order. */
export function parseWorksheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rowMatches = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];

  return rowMatches.map((rowMatch) => {
    const cellMatches = [...rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
    const cells: Cell[] = cellMatches.map((cm) => {
      const attrs = cm[1];
      const body = cm[2];
      const ref = attrs.match(/r="([^"]+)"/)?.[1] ?? "";
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";

      let value: string;
      if (type === "s") {
        const idx = parseInt(rawValue, 10);
        value = sharedStrings[idx] ?? "";
      } else if (type === "inlineStr") {
        value = decodeHtmlEntities(body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
      } else {
        value = decodeHtmlEntities(rawValue);
      }
      return { ref, value };
    });

    // Sort by column letters so sparse rows (not every column populated)
    // still come out left-to-right in the right order.
    cells.sort((a, b) => columnLetters(a.ref).localeCompare(columnLetters(b.ref)));
    return cells.map((c) => c.value);
  });
}

/** Render parsed rows the same "header: value" way csvParser does — consistent retrieval shape across tabular formats. */
export function rowsToReadableText(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...dataRows] = rows;
  return dataRows
    .map(
      (row, i) =>
        header.map((h, col) => `${h.trim() || `column_${col + 1}`}: ${row[col] ?? ""}`).join("\n") +
        `\n(row ${i + 1})`,
    )
    .join("\n\n");
}

export const xlsxParser: DocumentParser = {
  sourceTypes: ["xlsx"],
  async parse(input: Buffer): Promise<string> {
    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(input);
    } catch (err) {
      throw new Error(`Not a valid .xlsx file (not a readable ZIP archive): ${String(err)}`);
    }

    const sheet = entries.get("xl/worksheets/sheet1.xml");
    if (!sheet) {
      throw new Error("Not a valid .xlsx file: missing xl/worksheets/sheet1.xml");
    }

    const sharedStringsXml = entries.get("xl/sharedStrings.xml");
    const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml.toString("utf8")) : [];

    const rows = parseWorksheetRows(sheet.toString("utf8"), sharedStrings);
    return rowsToReadableText(rows);
  },
};
