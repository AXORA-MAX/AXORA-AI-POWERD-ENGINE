import { inflateRawSync } from "node:zlib";

/**
 * A real ZIP reader implementing just enough of APPNOTE.TXT (the ZIP
 * format spec) to extract named entries from DOCX/PPTX/XLSX files —
 * which are all ZIP containers of XML parts. Written from scratch
 * because no zip library (jszip, adm-zip, yauzl, ...) is installable in
 * this sandbox (no network), but Node's built-in `zlib` has everything
 * actually needed: `inflateRawSync` for DEFLATE decompression and
 * `crc32` for the writer-side test fixtures (see miniZip.test.ts).
 *
 * Scope: reads the central directory and decompresses named entries on
 * demand. Does not support multi-disk archives, ZIP64 (files >4GB or
 * >65535 entries), or writing — none of which real-world DOCX/PPTX/XLSX
 * files need.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD sits at the end of the file, optionally followed by a comment
  // (max 65535 bytes) — scan backward from the end for its signature.
  const maxCommentLength = 65535;
  const searchStart = Math.max(0, buffer.length - 22 - maxCommentLength);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Not a valid ZIP file: End Of Central Directory record not found");
}

function readCentralDirectory(buffer: Buffer): CentralDirEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries: CentralDirEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`Corrupt ZIP: expected central directory signature at offset ${offset}`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function extractEntry(buffer: Buffer, entry: CentralDirEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Corrupt ZIP: expected local file header signature at offset ${offset}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed); // stored, no compression
  if (entry.compressionMethod === 8) return inflateRawSync(compressed); // DEFLATE
  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

/** Read every entry in a ZIP archive into a name -> decompressed-bytes map. */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const centralDir = readCentralDirectory(buffer);
  const result = new Map<string, Buffer>();
  for (const entry of centralDir) {
    if (entry.name.endsWith("/")) continue; // directory entry, no data
    result.set(entry.name, extractEntry(buffer, entry));
  }
  return result;
}

/** List entry names without decompressing anything — useful for picking which slides/sheets exist. */
export function listZipEntryNames(buffer: Buffer): string[] {
  return readCentralDirectory(buffer)
    .filter((e) => !e.name.endsWith("/"))
    .map((e) => e.name);
}
