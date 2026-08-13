import * as cheerio from "cheerio";
import { fetchHtml } from "./http.js";
import type { PropertyRow } from "../knowledge/properties.js";
import { parseAgentMetaFromCheerio } from "./parseAgentMeta.js";

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function parseSpanishMoney(raw: string): number | null {
  const t = raw.replace(/\s/g, "").replace(/€/g, "").replace(/\u00a0/g, "");
  const digits = t.replace(/[^\d.,]/g, "");
  if (!digits) return null;
  if (digits.includes(",") && digits.includes(".")) {
    const lastComma = digits.lastIndexOf(",");
    const lastDot = digits.lastIndexOf(".");
    const decSep = lastComma > lastDot ? "," : ".";
    const thouSep = decSep === "," ? "." : ",";
    const normalized = digits.replace(new RegExp(`\\${thouSep}`, "g"), "").replace(decSep, ".");
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
  }
  if (digits.includes(".")) {
    const parts = digits.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      const n = Number.parseFloat(digits.replace(/\./g, "").replace(/,/g, "."));
      return Number.isFinite(n) ? n : null;
    }
    const n = Number.parseFloat(digits.replace(/\./g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (digits.includes(",")) {
    const n = Number.parseFloat(digits.replace(/,/g, "."));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

function parseAreaM2(raw: string): number | null {
  const m = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseH1(h1: string): { property_type: string | null; transaction_type: string | null; location: string | null } {
  const t = normalizeText(h1);
  const re =
    /^(.+?)\s+en\s+(Venta|Alquiler|Alquiler\s+Vacacional|Traspaso|Reformas)\s+en\s+(.+)$/iu;
  const m = t.match(re);
  if (!m) return { property_type: null, transaction_type: null, location: null };
  return {
    property_type: normalizeText(m[1]) || null,
    transaction_type: normalizeText(m[2].replace(/\s+/g, " ")) || null,
    location: normalizeText(m[3]) || null,
  };
}

export async function scrapePropertyPage(baseUrl: string, ref: string): Promise<PropertyRow | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/propiedad?propiedad=${encodeURIComponent(ref)}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const h1 = normalizeText($("h1").first().text());
  const parsed = parseH1(h1);

  const names = $("h2.price");
  const titleName = normalizeText(names.eq(0).text());
  const priceRaw = normalizeText(names.eq(1).text());

  const feats = $(".features .feature");
  const areaRaw = normalizeText(feats.eq(0).text());
  const bedRaw = normalizeText(feats.eq(1).text());
  const bathRaw = normalizeText(feats.eq(2).text());

  const refText = normalizeText($("h3:contains('Ref:')").first().text());
  const refMatch = refText.match(/Ref:\s*(\d+)/i);
  const refFinal = refMatch?.[1] ?? ref;

  const locFromPanel = normalizeText(
    $("h3.text-center").filter((_, el) => $(el).find("i.fa-map-marker").length > 0).first().text()
  );
  const location =
    parsed.location ??
    (locFromPanel ? locFromPanel.replace(/^en\s+/i, "").trim() : null);

  const featureLis: string[] = [];
  $("ul.list-unstyled li").each((_, el) => {
    const txt = normalizeText($(el).text());
    if (txt) featureLis.push(txt);
  });

  const descriptionHtml = $(".property-description").first().html() ?? "";
  const description = normalizeText(
    descriptionHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  );

  const price = parseSpanishMoney(priceRaw);
  const area_m2 = parseAreaM2(areaRaw);
  const bedrooms = Number.parseInt(bedRaw, 10);
  const bathrooms = Number.parseInt(bathRaw, 10);

  if (!titleName && !h1) return null;

  const agentMeta = parseAgentMetaFromCheerio($);

  return {
    ref: refFinal,
    title: titleName || h1 || `Propiedad ${refFinal}`,
    property_type: parsed.property_type,
    transaction_type: parsed.transaction_type,
    price: price,
    area_m2: Number.isFinite(area_m2) ? area_m2 : null,
    bedrooms: Number.isFinite(bedrooms) ? bedrooms : null,
    bathrooms: Number.isFinite(bathrooms) ? bathrooms : null,
    location,
    features: featureLis.length ? JSON.stringify(featureLis) : null,
    description: description || null,
    url,
    agent_name: agentMeta?.agent_name ?? null,
    agent_phone: agentMeta?.agent_phone ?? null,
    agent_user_id: agentMeta?.agent_user_id ?? null,
  };
}
