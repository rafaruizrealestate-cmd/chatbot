import { resolvePropertyRefFromCatalog, searchProperties, type PropertyRow } from "../knowledge/properties.js";
import {
  extractBarePropertyRef,
  extractPropertyRefFromText,
  sanitizePropertyRef,
} from "../utils/propertyRef.js";
import type { AgentContact } from "../agents/assignment.js";
import { isGarbageClientName } from "../utils/portalLeadText.js";
import { guessBuyerTransactionType } from "./intent.js";
import {
  formatCustomerPropertyMessage,
  type CustomerPropertyMessageOpts,
} from "./customerPropertyMessage.js";

export const PROPERTY_NOT_IN_PORTFOLIO =
  "Lo lamento, esa propiedad no la tenemos. Te invito a visitar www.mamboinmobiliaria.com e indicarnos cuál te gusta.";

export type PropertySearchSignals = {
  ref: string | null;
  location: string | null;
  propertyType: string | null;
  transactionType: "Venta" | "Alquiler" | null;
  minPrice: number | null;
  maxPrice: number | null;
  bedrooms: number | null;
};

const KNOWN_LOCATIONS = [
  "rincon de la victoria",
  "caleta de velez",
  "velez-malaga",
  "velez malaga",
  "torre del mar",
  "valle niza",
  "benajarafe",
  "benamocarra",
  "almayate",
  "mezquitilla",
  "algarrobo",
  "periana",
  "torrox",
  "nerja",
  "chilches",
  "trapiche",
  "competa",
  "sayalonga",
  "canillas",
  "cajiz",
  "arenas",
  "la victoria",
  "mijas golf",
  "mijas costa",
  "torremolinos",
  "benalmadena",
  "fuengirola",
  "estepona",
  "marbella",
  "mijas",
  "malaga",
  "perchel norte",
  "perchel sur",
  "perchel",
  "trinidad",
];

const LOCATION_ALIASES: Record<string, string> = {
  "el rincon": "rincon de la victoria",
  rincon: "rincon de la victoria",
  "la victoria": "victoria",
  victoria: "victoria",
  "perchel norte": "perchel norte",
  perchel: "perchel",
  "velez-malaga": "velez malaga",
  "el velez": "velez malaga",
  velez: "velez malaga",
  "belen malaga": "velez malaga",
  "torre del mar": "torre del mar",
  "la caleta": "caleta de velez",
};

const TRANSACTION_WORDS = new Set([
  "alquiler",
  "alquilar",
  "venta",
  "vender",
  "compra",
  "comprar",
  "arrendar",
]);

const PROPERTY_TYPE_RE =
  /\b(chalet|villa|piso|aticos?|áticos?|duplex|dúplex|adosados?|parcelas?|terrenos?|local(?:es)?|garaje(?:s)?|oficina(?:s)?|nave(?:s)?)\b/i;

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractPropertyType(text: string): string | null {
  const m = text.match(PROPERTY_TYPE_RE);
  if (!m?.[1]) return null;
  const raw = m[1]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (raw === "villa") return "Chalet";
  if (raw.startsWith("local")) return "Local";
  if (raw.startsWith("oficina")) return "Oficina";
  if (raw.startsWith("garaje")) return "Garaje";
  if (raw.startsWith("nave")) return "Nave";
  if (raw.startsWith("terreno") || raw.startsWith("parcela")) return "Terreno";
  if (raw.startsWith("atico")) return "Atico";
  if (raw.startsWith("duplex")) return "Duplex";
  if (raw.startsWith("adosado")) return "Adosado";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function priceDelta(n: number): number {
  if (n < 15_000) return Math.max(80, Math.round(n * 0.12));
  return Math.max(50_000, Math.round(n * 0.08));
}

function parsePriceRange(text: string): { min: number | null; max: number | null } {
  const t = normalize(text);
  if (/\b(un\s+)?mill[oó]n\s+y\s+(pico|medio|algo)\b/.test(t)) {
    return { min: 1_000_000, max: 1_500_000 };
  }
  if (/\b(un\s+)?mill[oó]n\b/.test(t)) {
    return { min: 900_000, max: 1_200_000 };
  }

  const rangeOr = text.match(/(\d{3,5})\s*(?:€|euros?)?\s*(?:o|u|-)\s*(\d{3,5})\s*€?/i);
  if (rangeOr?.[1] && rangeOr?.[2]) {
    const a = Number.parseInt(rangeOr[1], 10);
    const b = Number.parseInt(rangeOr[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const delta = priceDelta(hi);
      return { min: Math.max(0, lo - delta), max: hi + delta };
    }
  }

  const prices = [...text.matchAll(/(\d{3,5})\s*€/gi)]
    .map((m) => Number.parseInt(m[1]!, 10))
    .filter((n) => Number.isFinite(n) && n >= 200 && n <= 5_000_000);
  if (prices.length) {
    const n = prices[prices.length - 1]!;
    const delta = priceDelta(n);
    return { min: Math.max(0, n - delta), max: n + delta };
  }

  return { min: null, max: null };
}

function cleanLocationCapture(raw: string): string | null {
  let loc = raw.trim().split(/[,();]/)[0]?.trim() ?? "";
  loc = loc.replace(/\s+(con|de|que|y|precio|tiene|vale|exactamente)\b.*$/i, "").trim();
  if (loc.length < 3) return null;
  const norm = normalize(loc);
  if (TRANSACTION_WORDS.has(norm)) return null;
  // Evita tratar "un chalet" / "el piso" como zona.
  if (PROPERTY_TYPE_RE.test(loc)) return null;
  if (/^(un|una|el|la|los|las)\s+/i.test(loc) && PROPERTY_TYPE_RE.test(loc)) return null;
  if (norm.startsWith("alquiler ")) loc = loc.replace(/^alquiler\s+/i, "").trim();
  return loc.length >= 3 ? loc : null;
}

function extractLocation(text: string): string | null {
  const t = normalize(text);
  for (const [alias, target] of Object.entries(LOCATION_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    if (t.includes(alias)) return target;
  }
  for (const loc of [...KNOWN_LOCATIONS].sort((a, b) => b.length - a.length)) {
    if (t.includes(normalize(loc))) return loc === "la victoria" ? "victoria" : loc;
  }
  const enLa = text.match(/\ben\s+(?:la|el|los|las)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40})/i)?.[1];
  if (enLa) {
    const cleaned = cleanLocationCapture(enLa);
    if (cleaned) return normalize(cleaned) === "victoria" ? "victoria" : cleaned;
  }
  const zone = text.match(/\b(?:zona|barrio)\s+(?:de\s+)?([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40})/i)?.[1];
  if (zone) {
    const cleaned = cleanLocationCapture(zone);
    if (cleaned) return cleaned;
  }
  const enGeneric = text.match(/\ben\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40}?)(?:\s+(?:con|de|que|y|precio|tiene|\d))/i)?.[1];
  if (enGeneric) {
    const cleaned = cleanLocationCapture(enGeneric);
    if (cleaned) return cleaned;
  }
  return null;
}

function guessTransaction(text: string): "Venta" | "Alquiler" | null {
  return guessBuyerTransactionType(text);
}

function extractBedrooms(text: string): number | null {
  const m =
    text.match(/\b(\d{1,2})\s*(hab|habs|habitaciones|dormitorios)\b/i) ??
    text.match(/\b(\d{1,2})\s*(bed|bedrooms)\b/i);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function extractPropertySearchSignals(text: string): PropertySearchSignals {
  const ref = resolvePropertyRefFromCatalog(text);
  const { min, max } = parsePriceRange(text);
  return {
    ref,
    location: extractLocation(text),
    propertyType: extractPropertyType(text),
    transactionType: guessTransaction(text),
    minPrice: min,
    maxPrice: max,
    bedrooms: extractBedrooms(text),
  };
}

function assistantAskedForPropertyRef(
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return /\b(referencia|ref\.?)\b/i.test(lastAssistant) &&
    /\b(dame|das|indica|pásame|pasame|ficha|enlace|inmobiliariabazan|mamboinmobiliaria|idealista)\b/i.test(lastAssistant);
}

/** “Las más baratas”, “qué tenéis”, listado sin ficha concreta. */
export function wantsBroadCatalogListing(text: string): boolean {
  const t = normalize(text);
  return (
    /\b(mas\s+barat[oa]s?|mas\s+econom|las\s+baratas|lo\s+mas\s+barato|viviendas?\s+barat|opciones?\s+barat|las\s+mas\s+baratas)\b/.test(
      t,
    ) ||
    /\b(que\s+ten[eé]is|que\s+teneis|muestrame|muestra(?:me)?|listado|catalogo|qu[eé]\s+hay)\b/.test(t)
  );
}

export function hasPropertySearchIntent(text: string): boolean {
  const s = extractPropertySearchSignals(text);
  if (s.ref) return true;
  if (s.location || s.propertyType || s.minPrice != null || s.bedrooms != null) return true;
  if (wantsBroadCatalogListing(text)) return true;
  return /\b(busco|interesa|ten[eé]is|tienen|anuncio|ficha|inmueble|propiedad|vivienda|casa|barat|visita|disponible)\b/i.test(
    text
  );
}

/** Variantes para LIKE de SQLite (no pliega tildes; Vélez-Málaga ≠ "velez malaga"). */
function locationQueryVariants(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.replace(/\s+/g, " ").trim();
    if (v.length >= 3 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  push(t);
  push(t.replace(/-/g, " "));
  push(t.replace(/\s+/g, "-"));
  const folded = normalize(t);
  push(folded);
  push(folded.replace(/-/g, " "));
  push(folded.replace(/\s+/g, "-"));
  const tokens = folded.split(/[\s-]+/).filter((x) => x.length >= 4 && !/^(malaga)$/.test(x));
  if (tokens[0]) push(tokens[0]);
  if (/\bvelez\b|\bbelen\b/.test(folded)) {
    push("Vélez");
    push("vélez");
    push("Vélez-Málaga");
  }
  if (/torre del mar/.test(folded)) push("Torre del Mar");
  if (/\balmayate\b/.test(folded)) push("Almayate");
  if (/\bperiana\b/.test(folded)) push("Periana");
  if (/caleta/.test(folded)) push("Caleta");
  return out;
}

export function searchBySignals(signals: PropertySearchSignals): PropertyRow[] {
  if (signals.ref) {
    const one = searchProperties({ ref: signals.ref, limit: 1 });
    return one.length ? one : [];
  }

  const filters: Parameters<typeof searchProperties>[0] = { limit: 8 };
  if (signals.transactionType) filters.transaction_type = signals.transactionType;
  if (signals.propertyType) filters.property_type = signals.propertyType;
  if (signals.minPrice != null) filters.min_price = signals.minPrice;
  if (signals.maxPrice != null) filters.max_price = signals.maxPrice;
  if (signals.bedrooms != null) filters.min_bedrooms = signals.bedrooms;

  const nonRes = /^(local|oficina|garaje|nave|terreno)$/i.test(signals.propertyType ?? "");
  if (!signals.propertyType) {
    filters.residential_only = true;
    filters.exclude_shared_rooms = true;
  } else if (nonRes) {
    filters.residential_only = false;
  } else {
    filters.residential_only = false;
    filters.exclude_shared_rooms = /piso|estudio|chalet|atico|duplex|adosado|vivienda/i.test(
      signals.propertyType,
    );
  }

  const locationsToTry = signals.location
    ? locationQueryVariants(signals.location)
    : [undefined];

  let rows: PropertyRow[] = [];
  for (const loc of locationsToTry) {
    rows = searchProperties({
      ...filters,
      ...(loc ? { location_contains: loc } : {}),
    });
    if (rows.length) return rows;
  }

  if (signals.location) {
    for (const loc of locationQueryVariants(signals.location)) {
      rows = searchProperties({
        ...(signals.propertyType ? { property_type: signals.propertyType } : {}),
        ...(signals.transactionType ? { transaction_type: signals.transactionType } : {}),
        location_contains: loc,
        residential_only: filters.residential_only,
        exclude_shared_rooms: filters.exclude_shared_rooms,
        limit: 8,
      });
      if (rows.length) return rows;
    }
    if (signals.propertyType) {
      rows = searchProperties({
        property_type: signals.propertyType,
        ...(signals.transactionType ? { transaction_type: signals.transactionType } : {}),
        residential_only: false,
        limit: 8,
      });
    }
  }
  return rows;
}

export function propertySearchAttemptCount(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  currentText: string
): number {
  const userTexts = history.filter((m) => m.role === "user").map((m) => m.content);
  userTexts.push(currentText);
  return userTexts.filter((t) => hasPropertySearchIntent(t)).length;
}

function formatPrice(price: number | null): string {
  if (price == null) return "";
  return `${price.toLocaleString("es-ES")} €`;
}

function formatPropertyLine(p: PropertyRow): string {
  const parts = [
    p.title,
    `(ref. ${p.ref})`,
    p.price != null ? formatPrice(p.price) : "",
    p.location ?? "",
  ].filter(Boolean);
  return parts.join(" — ");
}

export function formatPropertyDetailShort(
  p: PropertyRow,
  agent: AgentContact | null | undefined,
  messageOpts?: Omit<CustomerPropertyMessageOpts, "property" | "agent">
): string {
  return formatCustomerPropertyMessage({
    property: p,
    agent,
    customerName: messageOpts?.customerName,
    leadOrigin: messageOpts?.leadOrigin,
    withClosing: messageOpts?.withClosing ?? false,
  });
}

export function formatPropertyMatches(
  rows: PropertyRow[],
  agent?: AgentContact | null,
  opts?: { conversational?: boolean }
): string {
  if (rows.length === 1) {
    return formatPropertyDetailShort(rows[0]!, agent);
  }
  if (opts?.conversational) {
    const lines = rows.slice(0, 5).map((p, i) => {
      const price = p.price != null ? `${p.price.toLocaleString("es-ES")} €` : "";
      const zone = p.location?.split(" en ")[0] ?? p.location ?? "";
      return `${i + 1}. ${p.title} (ref. ${p.ref})${price ? ` — ${price}` : ""}${zone ? ` — ${zone}` : ""}`;
    });
    return [
      "He encontrado varias opciones que pueden encajar:",
      "",
      lines.join("\n"),
      "",
      "¿Cuál te encaja mejor? Puedes decirme el número o la referencia.",
    ].join("\n");
  }
  const lines = rows.slice(0, 3).map((p) => `• ${formatPropertyLine(p)}`);
  return `He encontrado estas opciones:\n${lines.join("\n")}\n¿Cuál te interesa (dime la referencia)?`;
}

type MissingField = "ref" | "zone" | "type" | "operation";

function nextMissingField(signals: PropertySearchSignals): MissingField | null {
  if (signals.ref) return null;
  if (!signals.location) return "zone";
  if (!signals.propertyType) return "type";
  if (!signals.transactionType) return "operation";
  return "ref";
}

function buildFollowUpQuestion(field: MissingField): string {
  switch (field) {
    case "zone":
      return "¿En qué zona o ciudad está el inmueble?";
    case "type":
      return "¿Qué tipo de inmueble es (piso, chalet, ático…)?";
    case "operation":
      return "¿Es para compra o alquiler?";
    case "ref":
      return "¿Me das la referencia de la ficha (o el enlace de Idealista / mamboinmobiliaria.com)?";
  }
}

export type UnresolvedSearchResult =
  | { kind: "found"; property: PropertyRow; reply: string }
  | { kind: "choices"; reply: string; properties: PropertyRow[] }
  | { kind: "follow_up"; reply: string }
  | { kind: "not_in_portfolio"; reply: string }
  | null;

/** Respuesta corta cuando aún no hay ficha clara. */
export function handleUnresolvedPropertySearch(opts: {
  combinedText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  currentText: string;
}): UnresolvedSearchResult {
  const { combinedText, history, currentText } = opts;
  if (!hasPropertySearchIntent(combinedText) && !extractBarePropertyRef(currentText)) return null;

  const signals = extractPropertySearchSignals(combinedText);
  const broadListing =
    wantsBroadCatalogListing(combinedText) || wantsBroadCatalogListing(currentText);
  if (broadListing && !signals.transactionType) {
    signals.transactionType = "Venta";
  }
  // Si el bot pidió la ref y el cliente responde solo "1616", priorizar ese número.
  const bareCurrent = extractBarePropertyRef(currentText);
  if (bareCurrent && (!signals.ref || assistantAskedForPropertyRef(history))) {
    signals.ref = bareCurrent;
  }

  if (signals.ref) {
    const byRef = searchProperties({ ref: signals.ref, limit: 1 });
    if (byRef[0]) {
      return { kind: "found", property: byRef[0], reply: formatPropertyMatches(byRef) };
    }
    return { kind: "not_in_portfolio", reply: PROPERTY_NOT_IN_PORTFOLIO };
  }

  let matches = searchBySignals(signals);

  if (!matches.length && (signals.minPrice != null || signals.maxPrice != null)) {
    matches = searchBySignals({ ...signals, minPrice: null, maxPrice: null });
  }
  if (!matches.length && signals.bedrooms != null) {
    matches = searchBySignals({ ...signals, minPrice: null, maxPrice: null, bedrooms: null });
  }

  if (matches.length === 1) {
    return { kind: "found", property: matches[0]!, reply: formatPropertyMatches(matches) };
  }
  if (matches.length > 1) {
    return {
      kind: "choices",
      properties: matches,
      reply: formatPropertyMatches(matches, undefined, { conversational: true }),
    };
  }

  if (broadListing) {
    return {
      kind: "follow_up",
      reply:
        "Ahora mismo no encuentro viviendas publicadas que encajen. ¿Pruebas otra zona o un presupuesto distinto?",
    };
  }

  const missing = nextMissingField(signals);
  if (missing && missing !== "ref") {
    return { kind: "follow_up", reply: buildFollowUpQuestion(missing) };
  }

  const hasSearchClues =
    Boolean(signals.location) ||
    signals.bedrooms != null ||
    signals.minPrice != null ||
    Boolean(signals.propertyType) ||
    Boolean(signals.transactionType);

  if (hasSearchClues) {
    return { kind: "follow_up", reply: buildFollowUpQuestion("ref") };
  }

  return { kind: "follow_up", reply: buildFollowUpQuestion(missing ?? "ref") };
}

function wantsPropertyVisit(text: string): boolean {
  return /\b(visita|visitar|verlo|quiero verlo|hacer una visita|coordinar(?:\s+la)?\s+visita|agendar(?:\s+una)?\s+visita)\b/i.test(
    text
  );
}

/** El asistente ya envió la ficha de esta ref en el historial. */
export function propertyAlreadyPresentedInHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  ref: string
): boolean {
  const needle = `(ref. ${ref})`;
  return history.some((m) => m.role === "assistant" && m.content.includes(needle));
}

/** Mensaje de seguimiento sobre un inmueble ya identificado (visita, nombre, más info…). */
export function isPropertyConversationFollowUp(text: string): boolean {
  if (wantsPropertyVisit(text)) return true;
  if (/\b(necesitas|necesitáis|necesito dar)\s+(mi\s+)?nombre\b/i.test(text)) return true;
  if (/\b(c[oó]mo\s+te\s+llam|mi\s+nombre\s+es|me\s+llamo)\b/i.test(text)) return true;
  if (/\b(m[aá]s detalles|m[aá]s info|informaci[oó]n adicional|disponible|amueblad|ascensor|garaje|gastos|comunidad)\b/i.test(text)) {
    return true;
  }
  if (/\b(hablar con|persona|humano|agente|comercial|llamad|contacto directo)\b/i.test(text)) {
    return true;
  }
  if (/\b(ayud|puedes|pod[eé]is|me\s+explicas|tienes\s+idea)\b/i.test(text)) return true;
  if (/^(s[ií]|ok|vale|perfecto|de acuerdo|claro|genial|hola)\b/i.test(text.trim())) return true;
  return false;
}

/** Respuesta fija corta (visita, nombre, hola breve). Lo demás → IA. */
export function shouldUseStructuredPropertyFollowUp(text: string): boolean {
  const t = text.trim();
  if (/\b(cuantos|cuántos|cuanto|cuánto|stock|numero|número|listado|catalogo|catálogo)\b/i.test(t)) {
    return false;
  }
  if (wantsPropertyVisit(text)) return true;
  if (/\b(necesitas|necesitáis|necesito dar)\s+(mi\s+)?nombre\b/i.test(text)) return true;
  if (/\bnombre\b/i.test(text) && t.length <= 80) return true;
  if (t.length <= 55 && /\b(hola|ayud)\b/i.test(text) && !/\?.*\?/.test(text)) return true;
  if (t.length <= 35 && /^hola\b/i.test(t)) return true;
  if (/^(s[ií]|ok|vale|perfecto|de acuerdo|claro|genial)\b/i.test(t)) return true;
  return false;
}

/** El cliente busca otro inmueble distinto al de la conversación en curso. */
export function isNewPropertySearchMessage(text: string, currentRef: string | null): boolean {
  const ref = resolvePropertyRefFromCatalog(text) ?? sanitizePropertyRef(extractPropertyRefFromText(text));
  if (ref && currentRef && ref !== currentRef) return true;
  if (ref && !currentRef) return true;
  if (currentRef && /\b(otro|otra|diferente)\s+(piso|inmueble|propiedad|ficha|anuncio)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** Respuesta corta tras la ficha inicial: visita, nombre, etc. */
export function buildPropertyFollowUpReply(opts: {
  userText: string;
  property: PropertyRow;
  customerName?: string | null;
  agent?: AgentContact | null;
  mentionAgent: boolean;
  visitConfirmed?: boolean;
}): string {
  const { userText, property, customerName, agent, mentionAgent, visitConfirmed } = opts;
  const agentName = agent?.name?.trim();
  const contactLine =
    mentionAgent && agentName
      ? `${agentName} se pondrá en contacto contigo para coordinar día y hora.`
      : "Tu comercial se pondrá en contacto contigo para coordinar la visita.";
  const name = customerName?.trim();
  const hasName = Boolean(name && !isGarbageClientName(name));

  if (wantsPropertyVisit(userText) || visitConfirmed) {
    if (/\bnombre\b/i.test(userText) && !hasName) {
      return `Sí, indícame tu nombre completo y ${agentName ?? "tu comercial"} te contactará para organizar la visita (ref. ${property.ref}).`;
    }
    if (hasName) {
      return `Perfecto, ${name}. Anoto tu interés en visitar el inmueble ref. ${property.ref}. ${contactLine}`;
    }
    return `Perfecto. ¿Me dices tu nombre completo para que ${agentName ?? "tu comercial"} coordine la visita (ref. ${property.ref})?`;
  }

  if (/\bnombre\b/i.test(userText)) {
    if (hasName) {
      return `Gracias, ${name}. ¿En qué más puedo ayudarte con el inmueble ref. ${property.ref}?`;
    }
    return `Sí, indícame tu nombre completo para que ${agentName ?? "tu comercial"} pueda contactarte sobre la ref. ${property.ref}.`;
  }

  if (/\b(ayud|puedes|pod[eé]is|hola)\b/i.test(userText)) {
    return `¡Hola! Claro. Seguimos con el inmueble ref. ${property.ref}. ¿Quieres visitarlo, más detalles o tienes alguna duda concreta?`;
  }

  return `Entendido. ¿En qué más puedo ayudarte con el inmueble ref. ${property.ref}?`;
}

export function buildOngoingPropertyConversationBlock(ref: string): string {
  return `\n\n--- Conversación en curso (ref. ${ref}) ---
La ficha completa (precio, m², URL) ya se envió al cliente. NO la repitas ni pegues el enlace otra vez.
Responde de forma natural, breve y coherente a la pregunta actual (visita, dudas, nombre, disponibilidad, etc.).
Si el cliente busca OTROS inmuebles (otra zona, estudio, 1 hab.), usa search_properties de nuevo y NO reutilices el comercial de ref. ${ref} para otra ficha.
Si pregunta algo general (p. ej. cuántos alquileres hay), usa search_properties y responde con datos reales.
--- Fin conversación en curso ---`;
}

/** Si el cliente elige «el 1», «el primero», etc. tras una lista numerada del asistente. */
export function extractRefFromNumberedChoice(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userText: string
): string | null {
  const pick = userText.match(/\b(?:el|la|numero|n[uú]mero)\s*(\d+|primero|segundo|tercero|cuarto|1º|2º|3º)\b/i);
  if (!pick?.[1]) return null;

  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const refs = [
    ...lastAssistant.matchAll(/propiedad\?propiedad=(\d{3,4})/gi),
    ...lastAssistant.matchAll(/\(ref\.?\s*(\d{3,4})\)/gi),
  ]
    .map((m) => m[1]!)
    .filter((r, i, a) => a.indexOf(r) === i);

  if (!refs.length) return null;

  const token = pick[1]!.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const indexMap: Record<string, number> = {
    "1": 0,
    primero: 0,
    "1o": 0,
    "2": 1,
    segundo: 1,
    "2o": 1,
    "3": 2,
    tercero: 2,
    "3o": 2,
    "4": 3,
    cuarto: 3,
  };
  const idx = indexMap[token];
  if (idx == null || idx >= refs.length) return null;
  return refs[idx] ?? null;
}

export function isPropertyBrowseOrSelectTurn(text: string): boolean {
  return /\b(tienes|ten[eé]is|busco|opciones|algo de|stock|cuantos|cu[aá]ntos|listado|el\s+\d|la\s+\d|el\s+primero|el\s+segundo|me gusta|estudio|piso entero|vivienda entera|compartido)\b/i.test(
    text
  );
}

export function buildPropertySearchPromptBlock(): string {
  return `\n\n--- Búsqueda de inmuebles ---
Si search_properties no devuelve resultados: mensaje CORTO (1-2 frases). Pregunta UN solo dato (referencia, zona, tipo o compra/alquiler). NO des por perdida la conversación con textos largos.
NO digas "no he encontrado en nuestra base de datos" en párrafos extensos.
Solo di "no la tenemos" si el cliente ha dado una referencia concreta que no existe en la base de datos.
Si hay zona, precio o habitaciones pero no identificas la ficha, pide la referencia o el enlace de inmobiliariabazan.com.
NO menciones comercial en búsquedas fallidas.
--- Fin búsqueda ---`;
}
