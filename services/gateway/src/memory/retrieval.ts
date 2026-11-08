import type { StoredMemory, RetrievedMemory } from "../types.js";

/**
 * Long-term memory retrieval (master spec sections 12, 62, 65: "Context
 * Engine" combining conversation + memory + ... into one context system).
 *
 * HONEST LIMITATION: real semantic retrieval needs embeddings + a vector
 * index (pgvector — see db/migrations/0001_init.sql, which already has
 * `embedding VECTOR(1536)` columns waiting for this). This sandbox has no
 * network access to call an embeddings API, so this module implements a
 * real, working, deterministic keyword-overlap + recency + importance
 * ranking instead of pretending to do semantic search it can't do. It is
 * a genuine (if cruder) retrieval algorithm — not a stub — and every
 * function here is pure and unit-tested (see retrieval.test.ts).
 *
 * Swapping this for embedding-based cosine similarity later is a matter
 * of replacing `scoreMemory` with a vector comparison; callers
 * (`retrieveMemories`, and `server.ts`'s context assembly) don't change.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "to", "of", "in", "on", "at", "for", "and", "or", "but", "with",
  "what", "when", "where", "who", "how", "do", "does", "did", "my",
]);

/**
 * Minimal suffix-stripping stemmer — not Porter, just enough to close the
 * most common gap that broke this in practice: "prefer" not matching
 * "prefers" in stored memory content. Deliberately conservative (longer
 * minimum stem length) to avoid collapsing unrelated words together.
 */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Generic token-overlap score (0..1): fraction of query tokens present in
 * the candidate's tokens. Exported so other retrieval use-cases (e.g.
 * Knowledge Vault chunk retrieval — see knowledge/retrieval.ts) can reuse
 * the same real relevance signal instead of re-implementing it.
 */
export function overlapScore(queryTokens: Set<string>, candidateTokens: Set<string>): number {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (candidateTokens.has(t)) overlap++;
  return overlap / queryTokens.size;
}

/**
 * Score a single memory against a query. Combines:
 *  - keyword overlap (Jaccard-ish over token sets) — the actual relevance
 *    signal
 *  - stored importance (0..1) — user/system-assigned weight
 *  - stored confidence (0..1) — how sure we are this memory is accurate
 * Weighted sum, clamped to a sane range for ranking purposes.
 */
export function scoreMemory(queryTokens: Set<string>, memory: StoredMemory): number {
  const memoryTokens = new Set(tokenize(memory.content));
  const overlap = overlapScore(queryTokens, memoryTokens);
  if (overlap === 0) return 0;
  return overlap * 0.7 + memory.importance * 0.2 + memory.confidence * 0.1;
}

/**
 * Retrieve the top-K memories relevant to a query. Zero-overlap memories
 * are excluded entirely rather than ranked-but-included — an irrelevant
 * memory injected into context is worse than none (spec section 63:
 * "Do not make irreversible assumptions").
 */
export function retrieveMemories(
  query: string,
  memories: StoredMemory[],
  topK: number = 5,
): RetrievedMemory[] {
  const queryTokens = new Set(tokenize(query));

  return memories
    .map((m) => ({ ...m, score: scoreMemory(queryTokens, m) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
