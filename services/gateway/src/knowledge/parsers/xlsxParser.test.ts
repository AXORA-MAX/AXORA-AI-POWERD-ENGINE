import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSharedStrings, parseWorksheetRows, rowsToReadableText, xlsxParser } from "./xlsxParser.js";
import { buildStoredZip } from "./zip/testFixtureZipWriter.js";

const SHARED_STRINGS_XML = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>product</t></si>
  <si><t>price</t></si>
  <si><t>Widget</t></si>
</sst>`;

// Row 1: header (shared strings 0, 1) -> "product", "price"
// Row 2: "Widget" (shared string 2) in A2, numeric 9.99 directly in B2
const SHEET_XML = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>9.99</v></c></row>
  </sheetData>
</worksheet>`;

test("parseSharedStrings extracts strings by index order", () => {
  const strings = parseSharedStrings(SHARED_STRINGS_XML);
  assert.deepEqual(strings, ["product", "price", "Widget"]);
});

test("parseWorksheetRows resolves shared-string cells and reads numeric cells directly", () => {
  const strings = parseSharedStrings(SHARED_STRINGS_XML);
  const rows = parseWorksheetRows(SHEET_XML, strings);
  assert.deepEqual(rows, [
    ["product", "price"],
    ["Widget", "9.99"],
  ]);
});

test("parseWorksheetRows sorts sparse cells into correct column order", () => {
  const strings: string[] = [];
  // Cells given out of order (C before A) — a real spreadsheet with a
  // blank B column would still emit A and C only, and column order
  // must be reconstructed from the cell references, not entry order.
  const sparse = `<worksheet><sheetData><row r="1"><c r="C1"><v>3</v></c><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
  const rows = parseWorksheetRows(sparse, strings);
  assert.deepEqual(rows, [["1", "3"]]);
});

test("rowsToReadableText renders header:value pairs like csvParser", () => {
  const text = rowsToReadableText([
    ["product", "price"],
    ["Widget", "9.99"],
  ]);
  assert.ok(text.includes("product: Widget"));
  assert.ok(text.includes("price: 9.99"));
});

test("xlsxParser end-to-end: real ZIP fixture with shared strings in, readable text out", async () => {
  const zip = buildStoredZip({
    "xl/sharedStrings.xml": SHARED_STRINGS_XML,
    "xl/worksheets/sheet1.xml": SHEET_XML,
  });
  const text = await xlsxParser.parse(zip);
  assert.ok(text.includes("product: Widget"));
  assert.ok(text.includes("price: 9.99"));
});

test("xlsxParser throws a clear error when sheet1 is missing", async () => {
  const zip = buildStoredZip({ "xl/sharedStrings.xml": SHARED_STRINGS_XML });
  await assert.rejects(() => xlsxParser.parse(zip), /missing xl\/worksheets\/sheet1\.xml/);
});
