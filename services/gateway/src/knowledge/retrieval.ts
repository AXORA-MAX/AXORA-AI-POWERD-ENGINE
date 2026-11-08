import { tokenize, overlapScore } from "../memory/retrieval.js";
import type { StoredKnowledgeChunk, RetrievedChunk } from "../types.js";

/**
 * Knowledge Vault retrieval (master spec section 14: "Retrieval" +
 * "Reranking" pipeline stages). Same honest limitation as long-term
 * memory retrieval (memory/retrieval.ts): this is keyword-overlap
 * ranking over chunk text, not embedding-based semantic search — no
 * network access to an embeddings API in this sandbox. Swapping this for
 * pgvector cosine similarity later doesn't change the caller contract.
 */
export function retrieveChunks(
  query: string,
  chunks: (StoredKnowledgeChunk & { document_title: string })[],
  topK: number = 5,
): RetrievedChunk[] {
  const queryTokens = new Set(tokenize(query));

  return chunks
    .map((c) => ({ ...c, score: overlapScore(queryTokens, new Set(tokenize(c.content))) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
