import { createRequire } from "node:module";
import mammoth from "mammoth";
import { chunkText } from "./chunker.js";
import { insertChunksBatch } from "./vectorStore.js";
import { embedTexts } from "../ai/embeddings.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse");

export async function ingestPlainText(sourceLabel: string, fullText: string): Promise<number> {
  const chunks = chunkText(fullText, 500, 50);
  if (chunks.length === 0) return 0;
  const embeddings = await embedTexts(chunks);
  insertChunksBatch(
    chunks.map((c, i) => ({
      source: `${sourceLabel}#${i}`,
      content: c,
      embedding: embeddings[i],
    }))
  );
  return chunks.length;
}

export async function ingestPdfBuffer(filename: string, buf: Buffer): Promise<number> {
  const { text } = await pdfParse(buf);
  return ingestPlainText(`file:${filename}`, text);
}

export async function ingestDocxBuffer(filename: string, buf: Buffer): Promise<number> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return ingestPlainText(`file:${filename}`, value);
}
