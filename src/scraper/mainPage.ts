import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { fetchHtml } from "./http.js";

const SECTION_IDS = ["about", "services", "tasacion", "hipotecas", "contact"] as const;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripNoise($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): void {
  root.find("script, style, noscript, iframe").remove();
}

export function extractMainKnowledgeSections(html: string): string {
  const $ = cheerio.load(html);
  $("#cookie-banner, #contacto-flotante, #navbar-main, footer").remove();
  const parts: string[] = [];
  for (const id of SECTION_IDS) {
    const el = $(`#${id}`);
    if (!el.length) continue;
    const clone = el.clone();
    stripNoise($, clone);
    const t = normalizeWhitespace(clone.text());
    if (t.length > 40) parts.push(`## ${id.toUpperCase()}\n${t}`);
  }
  const metaDesc = $('meta[name="description"]').attr("content");
  if (metaDesc) parts.unshift(`Descripción del sitio (meta): ${normalizeWhitespace(metaDesc)}`);
  const hasNamedSections = parts.some((p) => p.startsWith("## "));
  if (hasNamedSections) return parts.join("\n\n");

  const main = $("main").first();
  if (main.length) {
    const clone = main.clone();
    stripNoise($, clone);
    clone.find("nav, footer, form").remove();
    const t = normalizeWhitespace(clone.text());
    if (t.length > 80) parts.push(t.slice(0, 4000));
  }
  return parts.join("\n\n");
}

export function discoverPropertyRefsFromHtml(html: string): Set<string> {
  const $ = cheerio.load(html);
  const refs = new Set<string>();
  $('a[href*="propiedad?propiedad="]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/propiedad\?propiedad=(\d+)/i);
    if (m) refs.add(m[1]);
  });
  return refs;
}

export async function scrapeMainPageKnowledge(baseUrl: string): Promise<string> {
  const html = await fetchHtml(baseUrl.replace(/\/$/, ""));
  return extractMainKnowledgeSections(html);
}

export async function discoverAllPropertyRefs(baseUrl: string): Promise<string[]> {
  const { isIdealistaTarget, discoverIdealistaRefs } = await import("./idealista.js");
  if (isIdealistaTarget(baseUrl)) {
    return discoverIdealistaRefs(baseUrl);
  }
  const origin = baseUrl.replace(/\/$/, "");
  const listingUrls = [
    `${origin}/propiedades`,
    `${origin}/propiedades?transaccion=Venta`,
    `${origin}/propiedades?transaccion=Alquiler`,
    `${origin}/propiedades?transaccion=Alquiler%20Vacacional`,
    `${origin}/propiedades?transaccion=Traspaso`,
    `${origin}/propiedades?transaccion=Reformas`,
    origin,
  ];
  const refs = new Set<string>();
  for (const u of listingUrls) {
    try {
      const html = await fetchHtml(u);
      for (const r of discoverPropertyRefsFromHtml(html)) refs.add(r);
    } catch {
      // listing variant may 404; skip
    }
  }

  // Permite forzar refs que existen pero no están listadas públicamente (paginación/filtros/ocultas).
  // Formato: "1713,1714 1715" (coma o espacios).
  const extraRaw = (process.env.SCRAPE_EXTRA_REFS ?? "").trim();
  if (extraRaw) {
    for (const part of extraRaw.split(/[\s,;]+/g)) {
      const r = part.trim();
      if (/^\d{3,6}$/.test(r)) refs.add(r);
    }
  }
  return [...refs].sort((a, b) => Number(a) - Number(b));
}
