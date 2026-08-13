import { config } from "../config.js";
import { embedQuery } from "./embeddings.js";
import { searchSimilarChunks } from "../knowledge/vectorStore.js";

export async function buildKnowledgeContext(userMessage: string): Promise<string> {
  const q = await embedQuery(userMessage);
  const hits = searchSimilarChunks(q, config.maxKnowledgeChunks);
  if (hits.length === 0) return "";
  return hits.map((h) => `### ${h.source} (relevancia ${h.score.toFixed(3)})\n${h.content}`).join("\n\n");
}
