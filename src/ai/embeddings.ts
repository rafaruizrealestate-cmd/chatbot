import OpenAI from "openai";
import { config, assertOpenAiConfigured } from "../config.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    assertOpenAiConfigured();
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return client;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const c = getClient();
  const res = await c.embeddings.create({
    model: config.openaiEmbeddingModel,
    input: texts,
  });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}
