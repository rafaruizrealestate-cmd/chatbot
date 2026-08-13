import { config } from "../config.js";
import { getDb } from "../db/database.js";
import { chunkText } from "../knowledge/chunker.js";
import { deleteChunksBySourcePrefix, insertChunksBatch } from "../knowledge/vectorStore.js";
import { countProperties, replaceAllProperties, type PropertyRow } from "../knowledge/properties.js";
import { embedTexts } from "../ai/embeddings.js";
import { discoverAllPropertyRefs, scrapeMainPageKnowledge } from "./mainPage.js";
import { scrapePropertyPage } from "./propertyPage.js";
import { sleep } from "./http.js";

export type ScrapeResult = {
  propertyCount: number;
  knowledgeChunkCount: number;
  refsDiscovered: number;
};

export async function runFullScrape(): Promise<ScrapeResult> {
  getDb();
  const base = config.scrapeTargetUrl.replace(/\/$/, "");

  deleteChunksBySourcePrefix("web:");

  const knowledgeText = await scrapeMainPageKnowledge(base);
  const chunks = chunkText(knowledgeText, 500, 50);
  let knowledgeChunkCount = 0;
  if (chunks.length > 0) {
    const embeddings = await embedTexts(chunks);
    insertChunksBatch(
      chunks.map((c, i) => ({
        source: `web:section#${i}`,
        content: c,
        embedding: embeddings[i],
      }))
    );
    knowledgeChunkCount = chunks.length;
  }

  const previousCount = countProperties();
  const refs = await discoverAllPropertyRefs(base);
  const properties: PropertyRow[] = [];
  for (const ref of refs) {
    try {
      const p = await scrapePropertyPage(base, ref);
      if (p) properties.push(p);
    } catch (e) {
      console.error(`[scrape] propiedad ${ref}:`, e);
    }
    await sleep(120);
  }

  // Safety guard: never wipe catalog on transient scrape failures.
  if (refs.length === 0 || properties.length === 0) {
    if (previousCount > 0) {
      throw new Error(
        `[scrape] abortado para evitar vaciar catálogo: refs=${refs.length}, propiedades=${properties.length}, previas=${previousCount}`
      );
    }
    console.warn(
      `[scrape] sin propiedades descubiertas (refs=${refs.length}, propiedades=${properties.length})`
    );
  }

  replaceAllProperties(properties);

  return {
    propertyCount: properties.length,
    knowledgeChunkCount,
    refsDiscovered: refs.length,
  };
}
