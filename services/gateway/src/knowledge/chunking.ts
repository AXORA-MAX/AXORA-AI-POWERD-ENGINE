/**
 * Knowledge Vault ingestion — the "parsing -> cleaning -> chunking"
 * portion of the RAG pipeline (master spec sections 13, 14):
 *
 *   Document -> Parsing -> Cleaning -> Chunking -> Metadata -> Embedding
 *   -> Vector Storage -> Retrieval -> Reranking -> Context Assembly -> Model
 *
 * HONEST SCOPE: this module implements everything up to and including
 * Chunking + Metadata. Embedding and Vector Storage need a reachable
 * embeddings API (OpenAI/Voyage/local) and pgvector — neither is
 * reachable from this sandbox (no network, no Postgres). Those stay as
 * the documented next step (see README) rather than being faked with
 * random vectors, which would silently corrupt every future similarity
 * search — worse than admitting the gap.
 *
 * Everything below IS real, working, and unit-tested: text cleaning,
 * paragraph-aware chunking with overlap, and per-chunk metadata.
 */

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters (not tokens — no tokenizer dependency). */
  maxChars?: number;
  /** How many characters of overlap to carry into the next chunk. */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

/**
 * Cleaning step: normalize whitespace/line endings without destroying
 * paragraph structure (chunking below depends on blank lines to find
 * good split points).
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n") // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to 1
    .replace(/[ \t]{2,}/g, " ") // collapse runs of spaces/tabs
    .trim();
}

/**
 * Chunking step. Splits on paragraph boundaries where possible, packing
 * paragraphs into chunks up to maxChars; a single paragraph longer than
 * maxChars is hard-split. Adjacent chunks share `overlapChars` of trailing
 * context, per spec section 14 ("Chunking" as its own pipeline stage with
 * retrieval-quality in mind — overlap avoids losing meaning at a chunk
 * boundary that split a sentence).
 */
export function chunkText(raw: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (overlapChars >= maxChars) {
    throw new Error("overlapChars must be smaller than maxChars");
  }

  const cleaned = cleanText(raw);
  if (cleaned.length === 0) return [];

  const paragraphs = cleaned.split(/\n\n+/).filter((p) => p.length > 0);

  const chunks: Chunk[] = [];
  let current = "";
  let currentStart = 0;
  let cursor = 0; // tracks position in `cleaned` as we walk paragraphs

  const pushChunk = (content: string, start: number) => {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    chunks.push({
      index: chunks.length,
      content: trimmed,
      charStart: start,
      charEnd: start + content.length,
    });
  };

  for (const paragraph of paragraphs) {
    const paragraphStart = cleaned.indexOf(paragraph, cursor);
    cursor = paragraphStart + paragraph.length;

    if (paragraph.length > maxChars) {
      // Flush whatever we were accumulating first.
      if (current.length > 0) {
        pushChunk(current, currentStart);
        current = "";
      }
      // Hard-split the oversized paragraph itself, with overlap.
      let pos = 0;
      while (pos < paragraph.length) {
        const end = Math.min(pos + maxChars, paragraph.length);
        pushChunk(paragraph.slice(pos, end), paragraphStart + pos);
        if (end === paragraph.length) break;
        pos = end - overlapChars;
      }
      currentStart = cursor;
      continue;
    }

    const candidate = current.length === 0 ? paragraph : current + "\n\n" + paragraph;
    if (candidate.length <= maxChars) {
      if (current.length === 0) currentStart = paragraphStart;
      current = candidate;
    } else {
      pushChunk(current, currentStart);
      // Start the new chunk with overlap from the tail of the previous one.
      const overlapTail = current.slice(Math.max(0, current.length - overlapChars));
      current = overlapTail.length > 0 ? overlapTail + "\n\n" + paragraph : paragraph;
      currentStart = paragraphStart - overlapTail.length;
    }
  }

  if (current.length > 0) pushChunk(current, currentStart);

  return chunks;
}
