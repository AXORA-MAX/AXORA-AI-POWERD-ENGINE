import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pdfParser } from "./pdfParser.js";

// pdf-lib ships a CJS build under cjs/; its ESM entry point isn't
// Node-ESM-resolvable (bundler-style extensionless imports), so this
// loads it the same way a real project would after `npm install pdf-lib`
// and using `require` for it specifically (devDependency, test-only —
// pdfParser.ts itself does not depend on pdf-lib, only on pdfjs-dist).
// (import.meta as any) sidesteps a TS ImportMeta typing gap from the
// missing @types/node in this sandbox — the same class of noise as the
// Buffer/process/console errors filtered elsewhere; import.meta.url
// itself is a real, working Node runtime feature.
const require = createRequire((import.meta as any).url);

test("pdfParser extracts real text from a real PDF built with pdf-lib", async () => {
  const { PDFDocument, StandardFonts } = require("pdf-lib");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText("AXORA Knowledge Vault PDF test.", { x: 20, y: 150, size: 16, font });
  page.drawText("Second line of real extracted text.", { x: 20, y: 120, size: 16, font });
  const bytes = await doc.save();

  const extracted = await pdfParser.parse(Buffer.from(bytes));

  assert.ok(extracted.includes("AXORA Knowledge Vault PDF test."));
  assert.ok(extracted.includes("Second line of real extracted text."));
});

test("pdfParser extracts text from a multi-page PDF, one page's text per output section", async () => {
  const { PDFDocument, StandardFonts } = require("pdf-lib");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([400, 200]);
  page1.drawText("Page one content.", { x: 20, y: 150, size: 16, font });
  const page2 = doc.addPage([400, 200]);
  page2.drawText("Page two content.", { x: 20, y: 150, size: 16, font });
  const bytes = await doc.save();

  const extracted = await pdfParser.parse(Buffer.from(bytes));

  assert.ok(extracted.includes("Page one content."));
  assert.ok(extracted.includes("Page two content."));
  // Pages are joined with a blank line, per pdfParser.ts.
  assert.ok(extracted.includes("Page one content.\n\nPage two content."));
});
