import type { DocumentParser } from "./types.js";

/**
 * Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas and
 * newlines inside quotes, and escaped quotes ("" -> "). Good enough for
 * real-world exported CSVs, not a full spec implementation (no custom
 * delimiters/dialects).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Render parsed rows as "header: value" text blocks — retrieval-friendly, not just a re-serialized CSV. */
export function csvToReadableText(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...dataRows] = rows;

  return dataRows
    .map((row, i) =>
      header
        .map((h, col) => `${h.trim() || `column_${col + 1}`}: ${row[col] ?? ""}`)
        .join("\n") + `\n(row ${i + 1})`,
    )
    .join("\n\n");
}

export const csvParser: DocumentParser = {
  sourceTypes: ["csv"],
  async parse(input: Buffer): Promise<string> {
    return csvToReadableText(parseCsv(input.toString("utf8")));
  },
};
