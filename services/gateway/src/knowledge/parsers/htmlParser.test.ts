import { test } from "node:test";
import assert from "node:assert/strict";
import { stripHtmlTags, decodeHtmlEntities, htmlParser } from "./htmlParser.js";

test("stripHtmlTags removes tags and converts block boundaries to newlines", () => {
  const html = "<html><body><h1>Title</h1><p>First para.</p><p>Second para.</p></body></html>";
  const stripped = stripHtmlTags(html);
  assert.ok(!stripped.includes("<"));
  assert.ok(stripped.includes("Title"));
  assert.ok(stripped.includes("First para."));
});

test("stripHtmlTags removes script and style content entirely, not just their tags", () => {
  const html = "<p>Visible</p><script>alert('should not appear')</script><style>.x{color:red}</style>";
  const stripped = stripHtmlTags(html);
  assert.ok(!stripped.includes("alert"));
  assert.ok(!stripped.includes("color:red"));
  assert.ok(stripped.includes("Visible"));
});

test("decodeHtmlEntities handles named and numeric entities", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeHtmlEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeHtmlEntities("caf&#233;"), "caf\u00e9");
  assert.equal(decodeHtmlEntities("&#x41;"), "A");
});

test("htmlParser end-to-end produces clean readable text", async () => {
  const html = Buffer.from(
    "<html><body><h1>AXORA</h1><p>The router selects a provider &amp; falls back to a default.</p></body></html>",
  );
  const text = await htmlParser.parse(html);
  assert.ok(text.includes("AXORA"));
  assert.ok(text.includes("The router selects a provider & falls back to a default."));
  assert.ok(!text.includes("<"));
});
