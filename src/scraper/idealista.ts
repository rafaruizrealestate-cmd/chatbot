import * as cheerio from "cheerio";
import type { PropertyRow } from "../knowledge/properties.js";
import { fetchRenderedHtml } from "./browser.js";
import { parseAreaM2, parseSpanishMoney, normalizeText } from "./parse.js";

const IDEALISTA_ID_RE = /^\d{6,12}$/;

export function isIdealistaTarget(url: string): boolean {
  return /idealista\.com/i.test(url);
}

export function idealistaPropertyUrl(id: string): string {
  return `https://www.idealista.com/inmueble/${encodeURIComponent(id)}/`;
}

function defaultAgent(): { name: string | null; phone: string | null } {
  const name = (process.env.LEAD_FALLBACK_AGENT_NAME ?? "").trim() || null;
  const phoneRaw = (process.env.LEAD_FALLBACK_AGENT_PHONE ?? "").replace(/\D+/g, "");
  const phone = phoneRaw.length >= 9 ? phoneRaw : null;
  return { name, phone };
}

export function discoverIdealistaIdsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $("article[data-element-id]").each((_, el) => {
    const id = ($(el).attr("data-element-id") ?? "").trim();
    if (IDEALISTA_ID_RE.test(id)) ids.add(id);
  });
  $('a[href*="/inmueble/"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/inmueble\/(\d{6,12})(?:\/|$)/i);
    if (m?.[1]) ids.add(m[1]);
  });
  return [...ids];
}

function listingPageUrls(proBase: string): string[] {
  const base = proBase.replace(/\/$/, "");
  return [
    `${base}/`,
    `${base}/alquiler-viviendas/`,
    `${base}/venta-obranueva/`,
  ];
}

function extraPaginationUrls(pageUrl: string, html: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(pageUrl);
  const out = new Set<string>();
  $('a[href*="pagina-"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href) return;
    try {
      const abs = new URL(href, origin).href;
      if (/\/pagina-\d+\.htm/i.test(abs)) out.add(abs.split("#")[0]!);
    } catch {
      // ignore
    }
  });
  return [...out];
}

export async function discoverIdealistaRefs(proBase: string): Promise<string[]> {
  const ids = new Set<string>();
  const seenPages = new Set<string>();
  const queue = listingPageUrls(proBase);

  for (const pageUrl of queue) {
    const key = pageUrl.replace(/\/$/, "");
    if (seenPages.has(key)) continue;
    seenPages.add(key);
    let html: string;
    try {
      html = await fetchRenderedHtml(pageUrl);
    } catch (e) {
      console.warn(`[scrape] listado Idealista omitido ${pageUrl}:`, e);
      continue;
    }
    for (const id of discoverIdealistaIdsFromHtml(html)) ids.add(id);
    for (const extra of extraPaginationUrls(pageUrl, html)) {
      if (!queue.includes(extra)) queue.push(extra);
    }
  }

  const extraRaw = (process.env.SCRAPE_EXTRA_REFS ?? "").trim();
  if (extraRaw) {
    for (const part of extraRaw.split(/[\s,;]+/g)) {
      const r = part.trim();
      if (IDEALISTA_ID_RE.test(r)) ids.add(r);
    }
  }

  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function capitalizeTx(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.startsWith("alquil")) return "Alquiler";
  if (t.startsWith("vent")) return "Venta";
  return raw.trim();
}

function parseIdealistaTitle(h1: string): {
  property_type: string | null;
  transaction_type: string | null;
  street: string | null;
} {
  const t = normalizeText(h1);
  const m = t.match(/^(.+?)\s+en\s+(venta|alquiler)(?:\s+en\s+(.+))?$/iu);
  if (!m) return { property_type: t || null, transaction_type: null, street: null };
  return {
    property_type: normalizeText(m[1]) || null,
    transaction_type: capitalizeTx(m[2]!),
    street: m[3] ? normalizeText(m[3]) : null,
  };
}

function fallbackAgentOnRow(row: PropertyRow): PropertyRow {
  const agent = defaultAgent();
  return {
    ...row,
    agent_name: row.agent_name?.trim() || agent.name,
    agent_phone: row.agent_phone?.replace(/\D+/g, "") || agent.phone,
  };
}

function typeFromTitle(title: string): string | null {
  const m = title.match(/^(.+?)\s+en\s+/i);
  return m ? normalizeText(m[1]) : null;
}

function locationFromTitle(title: string): string | null {
  const m = title.match(/^.+?\s+en\s+(.+)$/i);
  return m ? normalizeText(m[1]) : null;
}

export function parseIdealistaListingCards(html: string, transactionHint: string | null = "Venta"): PropertyRow[] {
  const $ = cheerio.load(html);
  const rows: PropertyRow[] = [];
  $("article[data-element-id]").each((_, el) => {
    const ref = ($(el).attr("data-element-id") ?? "").trim();
    if (!IDEALISTA_ID_RE.test(ref)) return;
    const title = normalizeText(
      $(el).find("a.item-link").attr("title") || $(el).find("a.item-link").first().text()
    );
    if (!title) return;
    const price = parseSpanishMoney($(el).find(".item-price").first().text());
    const details: string[] = [];
    $(el).find(".item-detail").each((_, d) => {
      const t = normalizeText($(d).text());
      if (t) details.push(t);
    });
    const desc = normalizeText($(el).find(".item-description").first().text());
    const blob = `${details.join(" · ")} ${desc}`;
    const bedRaw = blob.match(/(\d+)\s*hab/i)?.[1] ?? desc.match(/(\d+)\s+dormitorios?/i)?.[1];
    const bathRaw = desc.match(/(\d+)\s+baños?/i)?.[1];
    const areaHit = details.find((d) => /m²/i.test(d)) ?? blob.match(/(\d+(?:[.,]\d+)?)\s*m²/i)?.[0];
    const bedrooms = bedRaw ? Number.parseInt(bedRaw, 10) : NaN;
    const bathrooms = bathRaw ? Number.parseInt(bathRaw, 10) : NaN;
    const pageTx = /alquiler/i.test(html.slice(0, 2500)) && transactionHint === "Alquiler" ? "Alquiler" : transactionHint;
    rows.push(
      fallbackAgentOnRow({
        ref,
        title,
        property_type: typeFromTitle(title),
        transaction_type: pageTx,
        price,
        area_m2: areaHit ? parseAreaM2(areaHit) : null,
        bedrooms: Number.isFinite(bedrooms) ? bedrooms : null,
        bathrooms: Number.isFinite(bathrooms) ? bathrooms : null,
        location: locationFromTitle(title),
        features: details.length ? JSON.stringify(details) : null,
        description: desc || null,
        url: idealistaPropertyUrl(ref),
        agent_name: null,
        agent_phone: null,
        agent_user_id: null,
      })
    );
  });
  return rows;
}

function transactionHintForListingUrl(pageUrl: string): string | null {
  if (/alquiler/i.test(pageUrl)) return "Alquiler";
  return "Venta";
}

export async function scrapeIdealistaCatalog(proBase: string): Promise<PropertyRow[]> {
  const byRef = new Map<string, PropertyRow>();
  const htmlPath = (process.env.SCRAPE_LISTING_HTML_PATH ?? "").trim();
  if (htmlPath) {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(htmlPath, "utf8");
    for (const row of parseIdealistaListingCards(html, "Venta")) byRef.set(row.ref, row);
    return [...byRef.values()];
  }

  const seenPages = new Set<string>();
  const queue = listingPageUrls(proBase);
  for (const pageUrl of queue) {
    const key = pageUrl.replace(/\/$/, "");
    if (seenPages.has(key)) continue;
    seenPages.add(key);
    let html: string;
    try {
      html = await fetchRenderedHtml(pageUrl);
    } catch (e) {
      console.warn(`[scrape] listado Idealista omitido ${pageUrl}:`, e);
      continue;
    }
    const hint = transactionHintForListingUrl(pageUrl);
    for (const row of parseIdealistaListingCards(html, hint)) byRef.set(row.ref, row);
    for (const extra of extraPaginationUrls(pageUrl, html)) {
      if (!queue.includes(extra)) queue.push(extra);
    }
  }
  return [...byRef.values()].sort((a, b) => Number(a.ref) - Number(b.ref));
}

export function parseIdealistaPropertyHtml(html: string, ref: string): PropertyRow | null {
  const $ = cheerio.load(html);
  const h1 = normalizeText($("h1 .main-info__title-main, h1").first().text());
  if (!h1) return null;

  const parsed = parseIdealistaTitle(h1);
  const locationMinor = normalizeText($(".main-info__title-minor").first().text().replace(/ver mapa/i, ""));
  const location = [parsed.street, locationMinor].filter(Boolean).join(", ") || locationMinor || parsed.street;

  const priceRaw = normalizeText($(".info-data-price .txt-bold").first().text())
    || normalizeText($(".info-data-price").first().text());
  const price = parseSpanishMoney(priceRaw);

  const featureLis: string[] = [];
  $(".details-property_features li, #details li").each((_, el) => {
    const txt = normalizeText($(el).text());
    if (txt && !/consumo:|emisiones:/i.test(txt)) featureLis.push(txt);
  });
  const featBlob = featureLis.join(" · ");

  let area_m2: number | null = null;
  const built = featBlob.match(/(\d+(?:[.,]\d+)?)\s*m²\s*construidos/i);
  if (built) area_m2 = parseAreaM2(built[1]!);
  if (area_m2 == null) {
    const anyM2 = featBlob.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    if (anyM2) area_m2 = parseAreaM2(anyM2[1]!);
  }

  const bedRaw = featBlob.match(/(\d+)\s+habitaciones?/i)?.[1];
  const bathRaw = featBlob.match(/(\d+)\s+baños?/i)?.[1];
  const bedrooms = bedRaw ? Number.parseInt(bedRaw, 10) : NaN;
  const bathrooms = bathRaw ? Number.parseInt(bathRaw, 10) : NaN;

  const descHtml = $(".adCommentsLanguage p").first().html()
    ?? $(".adCommentsLanguage").first().html()
    ?? "";
  const description = normalizeText(
    descHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  );

  let transaction_type = parsed.transaction_type;
  const op = html.match(/operation:\s*'([^']+)'/i)?.[1]?.toLowerCase();
  if (!transaction_type && op === "sale") transaction_type = "Venta";
  if (!transaction_type && op === "rent") transaction_type = "Alquiler";

  const row: PropertyRow = {
    ref,
    title: h1,
    property_type: parsed.property_type,
    transaction_type,
    price,
    area_m2: Number.isFinite(area_m2) ? area_m2 : null,
    bedrooms: Number.isFinite(bedrooms) ? bedrooms : null,
    bathrooms: Number.isFinite(bathrooms) ? bathrooms : null,
    location: location || null,
    features: featureLis.length ? JSON.stringify(featureLis) : null,
    description: description || null,
    url: idealistaPropertyUrl(ref),
    agent_name: null,
    agent_phone: null,
    agent_user_id: null,
  };
  return fallbackAgentOnRow(row);
}

export async function scrapeIdealistaProperty(ref: string): Promise<PropertyRow | null> {
  const html = await fetchRenderedHtml(idealistaPropertyUrl(ref));
  return parseIdealistaPropertyHtml(html, ref);
}
