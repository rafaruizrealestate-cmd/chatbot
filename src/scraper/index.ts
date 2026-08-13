import { config } from "../config.js";
import { getDb } from "../db/database.js";
import { chunkText } from "../knowledge/chunker.js";
import { deleteChunksBySourcePrefix, insertChunksBatch } from "../knowledge/vectorStore.js";
import { countProperties, replaceAllProperties, type PropertyRow } from "../knowledge/properties.js";
import { rememberPortalListing } from "../knowledge/portalListings.js";
import { embedTexts } from "../ai/embeddings.js";
import { discoverAllPropertyRefs, scrapeMainPageKnowledge } from "./mainPage.js";
import { scrapePropertyPage } from "./propertyPage.js";
import { isIdealistaTarget, scrapeIdealistaCatalog } from "./idealista.js";
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

  const knowledgeUrl = config.scrapeKnowledgeUrl.replace(/\/$/, "");
  let knowledgeText = "";
  try {
    knowledgeText = await scrapeMainPageKnowledge(knowledgeUrl);
  } catch (e) {
    console.warn("[scrape] conocimiento de la web omitido:", e);
  }
  const chunks = chunkText(knowledgeText, 500, 50);
  let knowledgeChunkCount = 0;
  if (chunks.length > 0) {
    try {
      const embeddings = await embedTexts(chunks);
      insertChunksBatch(
        chunks.map((c, i) => ({
          source: `web:section#${i}`,
          content: c,
          embedding: embeddings[i],
        }))
      );
      knowledgeChunkCount = chunks.length;
    } catch (e) {
      console.warn("[scrape] embeddings de conocimiento omitidos:", e);
    }
  }

  const previousCount = countProperties();
  const properties: PropertyRow[] = [];

  if (isIdealistaTarget(base)) {
    const scraped = await scrapeIdealistaCatalog(base);
    for (const p of scraped) {
      properties.push(p);
      rememberPortalListing("idealista", p.ref, p.ref);
    }
  } else {
    const refs = await discoverAllPropertyRefs(base);
    for (const ref of refs) {
      try {
        const p = await scrapePropertyPage(base, ref);
        if (p) properties.push(p);
      } catch (e) {
        console.error(`[scrape] propiedad ${ref}:`, e);
      }
      await sleep(120);
    }
  }

  // Safety guard: never wipe catalog on transient scrape failures.
  if (properties.length === 0) {
    if (previousCount > 0) {
      throw new Error(
        `[scrape] abortado para evitar vaciar catálogo: propiedades=0, previas=${previousCount}`
      );
    }
    console.warn("[scrape] sin propiedades descubiertas");
  }

  replaceAllProperties(properties);

  return {
    propertyCount: properties.length,
    knowledgeChunkCount,
    refsDiscovered: properties.length,
  };
}
