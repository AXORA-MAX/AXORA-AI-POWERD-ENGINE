import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { crc32 } from "node:zlib";
import { readZipEntries, listZipEntryNames } from "./miniZip.js";
import { buildStoredZip } from "./testFixtureZipWriter.js";

test("readZipEntries extracts a single stored (uncompressed) entry correctly", () => {
  const zip = buildStoredZip({ "hello.txt": "Hello, AXORA!" });
  const entries = readZipEntries(zip);
  assert.equal(entries.get("hello.txt")?.toString("utf8"), "Hello, AXORA!");
});

test("readZipEntries extracts multiple entries with correct names and content", () => {
  const zip = buildStoredZip({
    "a.txt": "first file",
    "dir/b.txt": "second file, in a subdirectory path",
    "c.json": JSON.stringify({ x: 1 }),
  });
  const entries = readZipEntries(zip);
  assert.equal(entries.size, 3);
  assert.equal(entries.get("a.txt")?.toString("utf8"), "first file");
  assert.equal(entries.get("dir/b.txt")?.toString("utf8"), "second file, in a subdirectory path");
  assert.equal(entries.get("c.json")?.toString("utf8"), '{"x":1}');
});

test("listZipEntryNames returns entry names without decompressing", () => {
  const zip = buildStoredZip({ "one.xml": "<a/>", "two.xml": "<b/>" });
  const names = listZipEntryNames(zip).sort();
  assert.deepEqual(names, ["one.xml", "two.xml"]);
});

test("readZipEntries correctly decompresses a real DEFLATE-compressed entry", () => {
  // Hand-build a single-entry ZIP with compression method 8 (DEFLATE)
  // instead of using buildStoredZip (which only writes stored entries),
  // to prove the inflateRawSync path in miniZip.ts actually works
  // against real deflated data, not just the stored/passthrough path.
  const original = Buffer.from("The AXORA Model Router selects a provider by mode.".repeat(20), "utf8");
  const compressed = deflateRawSync(original);
  const crc = crc32(original) >>> 0;
  const name = Buffer.from("doc.xml", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // DEFLATE
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(original.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10); // DEFLATE
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(original.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // local header at offset 0

  const centralDirStart = localHeader.length + name.length + compressed.length;
  const centralDir = Buffer.concat([centralHeader, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  const zip = Buffer.concat([localHeader, name, compressed, centralDir, eocd]);

  const entries = readZipEntries(zip);
  assert.equal(entries.get("doc.xml")?.toString("utf8"), original.toString("utf8"));
});

test("readZipEntries throws a clear error on a non-ZIP buffer", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip file at all")), /End Of Central Directory/);
});
