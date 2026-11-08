import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, csvToReadableText, csvParser } from "./csvParser.js";

test("parseCsv handles a simple unquoted CSV", () => {
  const rows = parseCsv("name,age\nAlice,30\nBob,25");
  assert.deepEqual(rows, [
    ["name", "age"],
    ["Alice", "30"],
    ["Bob", "25"],
  ]);
});

test("parseCsv handles quoted fields containing commas and newlines", () => {
  const rows = parseCsv('name,note\n"Smith, John","Line one\nLine two"\nJane,plain');
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, John", "Line one\nLine two"],
    ["Jane", "plain"],
  ]);
});

test("parseCsv handles escaped double quotes inside quoted fields", () => {
  const rows = parseCsv('title\n"She said ""hello"" to me"');
  assert.deepEqual(rows, [["title"], ['She said "hello" to me']]);
});

test("csvToReadableText renders header:value pairs per row", () => {
  const rows = [
    ["name", "age"],
    ["Alice", "30"],
  ];
  const text = csvToReadableText(rows);
  assert.ok(text.includes("name: Alice"));
  assert.ok(text.includes("age: 30"));
});

test("csvParser end-to-end produces retrieval-friendly text", async () => {
  const csv = Buffer.from("product,price\nWidget,9.99\nGadget,19.99");
  const text = await csvParser.parse(csv);
  assert.ok(text.includes("product: Widget"));
  assert.ok(text.includes("price: 19.99"));
});
