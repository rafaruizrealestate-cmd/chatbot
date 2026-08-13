import type OpenAI from "openai";
import { appendMessage, getMessagesForOpenAI } from "../db/conversations.js";
import { applyBotLoopGuard } from "./botLoopGuard.js";
import { generateAssistantReply, type ContactChannelHint } from "../ai/openai.js";
import {
  applyDeliveryChannels,
  clearMissedCallPending,
  getLeadProfileName,
  getLeadProfile,
  getMissedCallLeadOrigin,
  hasRecentLeadNotification,
  insertLeadNotification,
  isMissedCallPending,
  upsertLeadProfile,
  clearLeadProfileRef,
} from "../db/leads.js";
import { resolvePropertyRefFromCatalog, searchProperties, type PropertyRow } from "../knowledge/properties.js";
import { publicPropertyUrl } from "../knowledge/propertyUrl.js";
import {
  ingestPortalMappingsFromText,
  resolveRefFromPortalText,
} from "../knowledge/portalListings.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import { detectLanguage } from "../utils/language.js";
import { normalizeRealEstateSynonyms } from "../utils/synonyms.js";
import {
  sanitizePropertyRef,
  scrubRefSourceText,
} from "../utils/propertyRef.js";
import {
  extractPortalContactName,
  extractPortalContactPhone,
  extractPortalContactEmail,
  isGarbageClientName,
  isGarbageCustomerEmail,
  sanitizeClientInfoForAgent,
  isGarbageClientInfo,
} from "../utils/portalLeadText.js";
import { extractPhoneFromText } from "../utils/phone.js";
import { type AgentContact } from "../agents/assignment.js";
import { config } from "../config.js";
import { formatLeadForAgent } from "../leads/agentNotification.js";
import {
  emptyDelivery,
  resolveClientChannel,
  toDeliveryJson,
} from "../leads/delivery.js";
import { deliverAgentLeadNotification } from "../leads/notifyAgentDelivery.js";
import { trackAiAction } from "../panel/aiActions.js";
import { sendVoiceClientWhatsAppConfirm } from "../voice/voiceLeadEmail.js";
import { isLikelyWhatsappNumber } from "./outbound.js";
import {
  isFirstConversationTurn,
  isGenericWhatsAppOpener,
  buildWhatsAppOpenerReply,
  shouldMentionAgentToCustomer,
} from "./greeting.js";
import {
  handleUnresolvedPropertySearch,
  formatPropertyDetailShort,
  hasPropertySearchIntent,
  propertyAlreadyPresentedInHistory,
  isNewPropertySearchMessage,
  buildPropertyFollowUpReply,
  shouldUseStructuredPropertyFollowUp,
  extractRefFromNumberedChoice,
  isPropertyBrowseOrSelectTurn,
} from "./propertySearch.js";
import {
  formatListingLinkReply,
  wantsListingLink,
  type CustomerPropertyMessageOpts,
} from "./customerPropertyMessage.js";
import { enrichPropertyWithAgent, loadPropertyByRef, resolveAssignedAgent } from "../knowledge/propertyAgent.js";
import { isAdministrativeConversation } from "./administrativeTopics.js";
import { isOwnerListingIntent, resolveLeadIntent } from "./intent.js";
import {
  formatBuyerServicesForWhatsApp,
  wantsBuyerServicesDetail,
} from "../knowledge/services.js";
import {
  appendAskNameIfNeeded,
  buildAskNameForHandoffReply,
  buildOwnerListingReply,
  detectWantsVisit,
  ensureAssignedAgentContact,
  hasValidCustomerName,
  isProfileRefStale,
  shouldAskNameForHandoff,
  shouldNotifyOwnerListingLead,
  shouldNotifyWhatsappAgentLead,
  shouldUseOwnerListingReply,
  summarizeOwnerListingIntent,
  summarizeWhatsappClientIntent,
  wantsHumanContact,
} from "./whatsappLeadFlow.js";

const INTERNAL_EMAIL_RE = /@(inmobiliariabazan\.com|inmobiliariabazan\.es)$/i;
/** Solo números corporativos del bot (no móviles de comerciales: permiten pruebas). */
const BLOCKED_CONTACT_PHONES = new Set(["34672594724", "34951870058", "34614037189"]);

function titleCaseName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function toOpenAIHistory(
  rows: Array<{ role: "user" | "assistant"; content: string }>
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractFirstRef(input: string): string | null {
  // Cruza candidatos con el catálogo scrapeado (agent_name/phone de la ficha).
  return resolvePropertyRefFromCatalog(input);
}

function extractRefFromAssistantReply(reply: string): string | null {
  const m = scrubRefSourceText(reply).match(/(?:ref(?:erencia)?\s*[:#]?\s*)(\d{3,4})/i);
  return m?.[1] ? sanitizePropertyRef(m[1]) : null;
}

function conversationPhoneDigits(key: string | null | undefined): string | null {
  if (!key?.trim()) return null;
  const d = key.replace(/\D+/g, "");
  return /^\d{8,15}$/.test(d) ? d : null;
}

/** Primera ref en texto del asistente sin cifras de alquiler mensual (evita confundir 1500€/mes con ref). */
function extractFirstRefFromAssistantReply(reply: string): string | null {
  const stripped = reply.replace(/\b\d{3,5}\s*€\s*\/\s*mes\b/gi, "").replace(/\b\d{3,5}\s*eur\s*\/\s*mes\b/gi, "");
  return extractFirstRef(stripped);
}

function hasClearIntent(input: string): boolean {
  const t = normalize(normalizeRealEstateSynonyms(input));
  return /\b(comprar|compra|alquiler|alquilar|vender|venta|traspaso|visita|visitar|ref(?:erencia)?)\b/.test(
    t
  );
}

function extractName(input: string): string | null {
  const looksLikeNonName = (cand: string): boolean => {
    const candNorm = normalize(cand);
    // Evitar que ocupaciones/roles se cuelen como "nombre" en emails y respuestas tipo formulario.
    if (
      /\b(estudiante|student|arquitect|dibujo|delineant|ingenier|comercial|asesor|agente|inmobiliari|jefe|manager|director|duenos?|dueños?|empresa|quimic|quimica|chemical|owner|landlord|capital|málaga|malaga|llamada|demostraci[oó]n)\b/.test(
        candNorm,
      )
    ) {
      return true;
    }
    if (
      /\b(comprar|compra|alquiler|alquilar|vender|venta|traspaso|visita|visitar|busco|interesad|referencia)\b/.test(
        candNorm,
      )
    ) {
      return true;
    }
    if (/^(es|para)\s+/.test(candNorm)) return true;
    return false;
  };

  /** Evita falsos positivos de "I am …" / frases en inglés que no son nombre propio. */
  const looksLikeNonPersonPhrase = (cand: string): boolean => {
    const candNorm = normalize(cand);
    if (cand.split(/\s+/).length > 5) return true;
    return /\b(contract|work|good|bad|sure|worried|interested|looking|sorry|happy|tired|busy|not|here|ready|afraid|confused|only|just|still|also|very)\b/.test(
      candNorm
    );
  };

  const norwegian = input.match(
    /(?:mitt\s+fulle\s+navn\s+er|mitt\s+navn\s+er|jeg\s+heter)\s+(.+?)(?:\s+og\s+|\s+and\s+|,|;|\n|\.\s|$)/i
  );
  if (norwegian?.[1]) {
    const clean = norwegian[1]
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.,;:]+$/, "");
    if (clean.length >= 2 && clean.length <= 80 && !looksLikeNonName(clean) && !looksLikeNonPersonPhrase(clean)) {
      return clean;
    }
  }

  const summaryLabeled =
    input.match(/\*\*Nombre completo\*\*\s*:\s*([A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]+(?:\s+[A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]+)*)/i) ??
    input.match(/\bNombre completo\b\s*:\s*([A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]+(?:\s+[A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]+)*)/i);
  if (summaryLabeled?.[1]) {
    const clean = summaryLabeled[1].trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
    if (clean.length >= 2 && clean.length <= 80 && !looksLikeNonName(clean) && !looksLikeNonPersonPhrase(clean)) {
      return clean;
    }
  }

  const explicitEs = input.match(/(?:me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]{2,50})/i);
  if (explicitEs?.[1]) {
    const clean = explicitEs[1].trim().replace(/\s+/g, " ");
    if (clean.length >= 2 && !looksLikeNonName(clean) && !looksLikeNonPersonPhrase(clean)) return clean;
  }

  const explicitEn = input.match(/(?:my name is)\s+([A-Za-zÁÉÍÓÚÑæøåÆØÅäöüÄÖÜáéíóúñ' -]{2,50})/i);
  if (explicitEn?.[1]) {
    const clean = explicitEn[1].trim().replace(/\s+/g, " ");
    if (clean.length >= 2 && !looksLikeNonName(clean) && !looksLikeNonPersonPhrase(clean)) return clean;
  }

  const iAm = input.match(/\b(?:i am|i'm|im)\s+([A-ZÁÉÍÓÚÑÆØÅÄÖÜ][a-záéíóúñæøåÆØÅäöüÄÖÜ']?(?:\s+[A-ZÁÉÍÓÚÑÆØÅÄÖÜ][a-záéíóúñæøåÆØÅäöüÄÖÜ']?){0,3})\b/);
  if (iAm?.[1]) {
    const clean = iAm[1].trim().replace(/\s+/g, " ");
    if (
      clean.length >= 2 &&
      clean.length <= 45 &&
      !looksLikeNonName(clean) &&
      !looksLikeNonPersonPhrase(clean) &&
      clean.split(/\s+/).length <= 4
    ) {
      return clean;
    }
  }

  // Fallback: muchos usuarios responden en varias líneas (p.ej. "Alvaro\nEmpresario\n4000\ncuanto antes").
  // En vez de quedarnos con la primera línea no vacía (que suele ser "si" o un número), buscamos una línea
  // que parezca nombre entre las primeras N líneas.
  const lines = input
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);

  const tryLine = (line: string): string | null => {
    // Evitar líneas que claramente no son nombres (números, dinero, confirmaciones).
    const ln = normalize(line);
    if (/\d/.test(line)) return null;
    if (/\b(si|sí|ok|vale|correcto|perfecto|yes)\b/.test(ln)) return null;
    if (line.length < 2 || line.length > 60) return null;

    // Mayúsculas o minúsculas: "Juan Pérez" y "juan pérez" / "alvaro bazan".
    const m = line.match(
      /^([A-Za-zÁÉÍÓÚÑáéíóúñÆØÅÄÖÜæøåäöü][A-Za-zÁÉÍÓÚÑáéíóúñÆØÅÄÖÜæøåäöü' -]{1,30}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñÆØÅÄÖÜæøåäöü][A-Za-zÁÉÍÓÚÑáéíóúñÆØÅÄÖÜæøåäöü' -]{1,30}){0,2})[.,]?(?:\s|$)/u,
    );
    const raw = m?.[1]?.trim().replace(/\s+/g, " ") ?? "";
    if (!raw) return null;
    if (looksLikeNonName(raw) || isGarbageClientName(raw)) return null;
    const words = raw.split(/\s+/);
    if (words.length < 1 || words.length > 3) return null;
    // Una sola palabra muy corta (p. ej. "ok") ya filtrada; nombres de 1–3 palabras ok.
    if (words.length === 1 && raw.length < 3) return null;
    return titleCaseName(raw);
  };

  for (const line of lines) {
    const cand = tryLine(line);
    if (cand) {
      const badStarts = new Set(["hola", "hi", "hello", "manual", "buenas", "good"]);
      const first = normalize(cand).split(" ")[0] ?? "";
      if (!badStarts.has(first)) return cand;
    }
  }

  // Último intento: si no hay saltos de línea, usa el texto completo.
  const candidate = tryLine(input.trim());
  if (!candidate) return null;
  const badStarts = new Set(["hola", "hi", "hello", "manual", "buenas", "good"]);
  const first = normalize(candidate).split(" ")[0] ?? "";
  if (badStarts.has(first)) return null;
  if (looksLikeNonName(candidate)) return null;
  return candidate;
}

function extractEmail(input: string): string | null {
  const fromPortal = extractPortalContactEmail(input);
  if (fromPortal) return fromPortal;
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const addr = m[0].trim().toLowerCase();
    if (isGarbageCustomerEmail(addr)) continue;
    return addr;
  }
  return null;
}

function scrubPhoneExtractionText(input: string): string {
  return input
    .replace(/servicio\s+utilizado[:\s]+[\d\s]+/gi, " ")
    .replace(/tel[eé]fono\s+de\s+redirecci[oó]n[:\s]+[\d\s]+/gi, " ")
    .replace(/recibida\s+en\s+el\s+tel[eé]fono[^.\n]*/gi, " ")
    .replace(/\b672\s*594\s*724\b/g, " ")
    .replace(/\b851\s*813\s*840\b/g, " ");
}

function extractPhoneAny(input: string): string | null {
  const scrubbed = scrubPhoneExtractionText(input);
  return extractPhoneFromText(scrubbed);
}

function extractAreaM2(input: string): number | null {
  const t = normalize(input);
  const m = t.match(/\b(\d{2,5})\s*(m2|m²|metros cuadrados|metros)\b/i);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function extractBedroomsCount(input: string): number | null {
  const t = normalize(input);
  const m =
    t.match(/\b(\d{1,2})\s*(hab|habs|habitaciones|dormitorios)\b/i) ??
    t.match(/\b(\d{1,2})\s*(bed|bedrooms)\b/i);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function extractCityZone(input: string): { city?: string; zone?: string } {
  // Heurística simple: ciudad y zona suelen ir en el texto tipo "en Málaga, zona X"
  const raw = input.replace(/\s+/g, " ");
  const city = raw.match(/\b(M[aá]laga|Torremolinos|Benalm[aá]dena|Fuengirola|Marbella|Rinc[oó]n de la Victoria|Estepona)\b/i)?.[1];
  const zone = raw.match(/\b(zona|barrio)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40})/i)?.[2];
  return {
    city: city ? city.trim() : undefined,
    zone: zone ? zone.trim() : undefined,
  };
}

function extractDesiredOwnerPrice(input: string): number | null {
  // Precio al que quiere vender o alquilar (orientativo)
  const t = normalize(input);
  const m = t.match(
    /\b(?:vender(?:la)?|venta|precio|pido|quiero|me gustaria|me gustaría)\b[^0-9]{0,40}(\d{3,9})(?:\s*€|\s*euros?)?/i
  );
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function extractPreferredContact(input: string): string | null {
  const t = normalize(input);
  if (/\b(whatsapp|wasap|wpp)\b/.test(t)) return "WhatsApp";
  if (/\b(email|correo)\b/.test(t)) return "Email";
  if (/\b(llamad|llamar|tel[eé]fono)\b/.test(t)) return "Llamada";
  return null;
}

function extractMoneyNearKeywords(input: string, keywords: string[]): number | null {
  const t = normalize(input);
  for (const kw of keywords) {
    const idx = t.indexOf(kw);
    if (idx === -1) continue;
    const part = input.slice(Math.max(0, idx), idx + 80);
    const m = part.match(/(\d{3,7})(?:\s*€|\s*euros?)?/i);
    if (m?.[1]) return Number.parseFloat(m[1]);
  }
  return null;
}

function detectGuarantor(input: string): boolean | null {
  const t = normalize(input);
  if (/\b(avalista|aval)\b/.test(t)) return true;
  if (/\b(no tengo aval|sin aval)\b/.test(t)) return false;
  return null;
}

function extractOccupation(input: string): string | null {
  const m =
    input.match(/(?:trabajo(?:\s+en)?|trabajo\s+de)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ]{3,80})/i) ??
    input.match(/(?:me dedico a)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ]{3,80})/i);
  if (!m?.[1]) return null;
  return m[1].trim().replace(/\s+/g, " ");
}

function extractMoveInTiming(input: string): string | null {
  const m =
    input.match(
      /(?:fecha de llegada|fecha de entrada|fecha llegada)\s*[*:]?\s*([^\n]{3,80})/i
    ) ??
    input.match(
      /(?:quiero entrar|entrar(?:ía)?|me gustaria entrar|me gustaría entrar|alquilar(?:lo)?|mud(?:arme|anza)|cuando)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ,.-]{3,60})/i
    ) ??
    input.match(/\b(ya|cuanto antes|este mes|mes que viene|próximo mes|la semana que viene)\b/i);
  return m?.[1]?.trim() ?? null;
}

function extractUrls(input: string): string[] {
  const m = input.match(/https?:\/\/[^\s)>\]]+/gi) ?? [];
  return Array.from(new Set(m.map((u) => u.replace(/[),.;]+$/, ""))));
}

function isExternalPortalUrl(url: string): boolean {
  // Solo URLs de anuncios (no tracking de email / redirects).
  return /(pisos\.com|fotocasa\.(es|pro)|indomio\.|yaencontre\.com|habitaclia\.com|milanuncios\.com)/i.test(url)
    || (/idealista\.com/i.test(url) && !/email\.return\.idealista\.com|col\.idealista\.com/i.test(url));
}

/** Enlace externo que no es ficha de inmobiliariabazan.com (no se abre por seguridad). */
function isUntrustedExternalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "inmobiliariabazan.com" || host.endsWith(".inmobiliariabazan.com")) return false;
    return true;
  } catch {
    return true;
  }
}

function extractPriceEur(input: string): number | null {
  const m = input.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,9})\s*€/);
  if (!m?.[1]) return null;
  const raw = m[1].replace(/\./g, "").replace(/,/g, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function guessTransactionType(input: string): "Venta" | "Alquiler" | null {
  const t = normalize(input);
  if (/\b(alquiler|alquilar|arrendar)\b/.test(t)) return "Alquiler";
  if (/\b(venta|vender|comprar|compra)\b/.test(t)) return "Venta";
  return null;
}

function extractLocationHint(input: string): string | null {
  const clean = (raw: string): string =>
    raw
      .trim()
      .split(/[,();]/)[0]
      ?.replace(/\s+en\s+(venta|alquiler)\s*$/i, "")
      .trim() ?? "";
  const fromCalle = input.match(/\bcalle\s+(?:de\s+)?([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40})/i)?.[1];
  if (fromCalle) {
    const h = clean(fromCalle);
    if (h.length >= 3) return h;
  }
  const fromZona = input.match(/\b(?:en|zona|barrio)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{3,40})/i)?.[1];
  if (fromZona) {
    const h = clean(fromZona);
    if (h.length >= 3) return h;
  }
  return null;
}

type ResolvedPropertyContext = {
  ref: string | null;
  property?: PropertyRow;
  aiContext: string;
};

/** Zonas de portal (Idealista) ↔ catálogo Bazán. */
function expandLocationHints(hint: string): string[] {
  const n = normalize(hint);
  const out = [hint.trim()].filter(Boolean);
  if (/\bpuerto\s*sol\b|\bpuertosol\b/.test(n)) {
    out.push("Puerto de la Torre", "Puertosol", "Grafito");
  }
  return Array.from(new Set(out));
}

async function resolvePropertyFromMessage(input: string): Promise<ResolvedPropertyContext> {
  ingestPortalMappingsFromText(input);

  let ref = extractFirstRef(input);
  let property = ref ? searchProperties({ ref, limit: 1 })[0] : undefined;

  // Portales bloquean scrapeo a menudo: resolver por id de anuncio → ref interna.
  if (!property) {
    const mapped = resolveRefFromPortalText(input);
    if (mapped) {
      const p = searchProperties({ ref: mapped, limit: 1 })[0];
      if (p) {
        ref = p.ref;
        property = p;
      } else {
        ref = mapped;
      }
    }
  }

  // Si el cliente pega URL de nuestra web, extraemos el id directamente.
  if (!property) {
    const urls = extractUrls(input).filter((u) => /inmobiliariabazan\.com/i.test(u));
    for (const url of urls.slice(0, 2)) {
      try {
        const u = new URL(url);
        const id =
          u.searchParams.get("propiedad") ??
          u.searchParams.get("id") ??
          u.pathname.match(/\/propiedad\/(\d{3,6})/i)?.[1] ??
          null;
        if (id) {
          const p = searchProperties({ ref: id, limit: 1 })[0];
          if (p) {
            ref = p.ref;
            property = p;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const tryByHint = (hint: string): PropertyRow | undefined => {
    for (const h of expandLocationHints(hint)) {
      const candidates = searchProperties({ location_contains: h, limit: 5 });
      if (candidates.length === 1) return candidates[0];
      const normalizedHint = normalize(h);
      const hit = candidates.find((p) =>
        normalize(`${p.title} ${p.location ?? ""}`).includes(normalizedHint)
      );
      if (hit) return hit;
    }
    return undefined;
  };

  if (!property) {
    // Por seguridad NO abrimos enlaces externos. Solo resolvemos por:
    // - mapa portal ID → ref (aprendido de emails / seeds)
    // - URL de inmobiliariabazan.com (id en la propia URL, sin fetch)
    const urls = extractUrls(input).filter(isExternalPortalUrl);
    for (const url of urls.slice(0, 3)) {
      const mapped = resolveRefFromPortalText(url);
      if (!mapped) continue;
      const p = searchProperties({ ref: mapped, limit: 1 })[0];
      if (p) {
        ref = p.ref;
        property = p;
        break;
      }
      ref = mapped;
    }
  }

  if (!property) {
    const hint = extractLocationHint(input);
    if (hint) {
      const p = tryByHint(hint);
      if (p) {
        ref = p.ref;
        property = p;
      }
    }
  }

  const aiContext = property
    ? `${input}\n\n[Contexto interno detectado]\n- Referencia detectada: ${property.ref}\n- Operación: ${property.transaction_type ?? "No indicada"}\n- Precio: ${property.price != null ? `${property.price} €` : "No indicado"}\n- Título: ${property.title}\n- Zona: ${property.location ?? "No indicada"}\n- URL: ${property.url ?? "No disponible"}`
    : input;

  return { ref: ref ?? null, property, aiContext };
}

export async function debugResolvePropertyFromMessage(input: string): Promise<{ ref: string | null; propertyRef: string | null }> {
  const r = await resolvePropertyFromMessage(input);
  return { ref: r.ref, propertyRef: r.property?.ref ?? null };
}

export type ProcessIncomingContext = {
  leadChannel: ContactChannelHint;
  customerDisplayId?: string;
  /** Nombre del cliente si ya se conoce (p. ej. email de portal). */
  customerName?: string | null;
  threadUrl?: string;
  /** Procedencia del lead (para el agente): idealista, fotocasa, habitatsoft, pisos.com, indomio, whatsapp, etc. */
  leadOrigin?: string;
  /** Lead de email/portal: canal de respuesta al cliente (whatsapp o email). */
  portalCustomerReply?: "whatsapp" | "email";
  /** Ref detectada en email/portal (prioritaria sobre extracción del cuerpo). */
  leadRef?: string | null;
  /** Email de portal: aviso al agente solo con datos del email actual (sin mezclar historial). */
  portalEmailLead?: boolean;
  /** Teléfono/email del cliente extraídos del email de portal actual. */
  leadContactPhone?: string | null;
  leadContactEmail?: string | null;
};

function resolveCustomerName(
  conversationKey: string,
  combinedText: string,
  ctx?: ProcessIncomingContext,
  history?: Array<{ role: "user" | "assistant"; content: string }>
): string | null {
  const fromCtx = ctx?.customerName?.trim();
  if (fromCtx && !isGarbageClientName(fromCtx)) return fromCtx;
  const fromPortal = extractPortalContactName(combinedText);
  if (fromPortal) return fromPortal;
  const fromText = extractName(combinedText);
  if (fromText && !isGarbageClientName(fromText)) return fromText;
  if (history?.length) {
    const histText = history.map((m) => m.content).join("\n");
    const fromHistPortal = extractPortalContactName(histText);
    if (fromHistPortal) return fromHistPortal;
    const fromAssistant = histText.match(
      /\*\*Nombre\*\*:\s*([^\n*]+)|\bNombre:\s*([A-Za-zÁÉÍÓÚÑáéíóúñ' -]{2,50})/i
    );
    const fromAssistName = (fromAssistant?.[1] ?? fromAssistant?.[2])?.trim();
    if (fromAssistName && !isGarbageClientName(fromAssistName)) return fromAssistName;
  }
  const fromProfile = getLeadProfileName(conversationKey);
  if (fromProfile && !isGarbageClientName(fromProfile)) return fromProfile;
  return null;
}

function resolveLeadRef(
  hintsRef: string | null | undefined,
  latestUserText: string,
  combinedText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  profileRef: string | null | undefined
): string | null {
  const fromHints = sanitizePropertyRef(hintsRef);
  if (fromHints) return fromHints;
  const fromLatest = extractFirstRef(latestUserText);
  if (fromLatest) return fromLatest;
  const fromCombined = extractFirstRef(combinedText);
  if (fromCombined) return fromCombined;
  const fromProfile = sanitizePropertyRef(profileRef);
  if (fromProfile) return fromProfile;
  const histText = history.map((m) => m.content).join("\n");
  return extractFirstRef(histText);
}

function isPaperworkFollowUp(text: string): boolean {
  return /\b(papeleo|documentaci[oó]n|aut[oó]nomo|qu[eé] tendr[ií]a que enviar|qu[eé] papeles|modelo \d+)\b/i.test(
    text
  );
}

function inferLeadChannel(conversationKey: string): ContactChannelHint {
  const k = conversationKey.trim();
  if (/^\d{8,20}$/.test(k)) return "whatsapp";
  if (k.startsWith("fb:")) return "messenger";
  if (k.startsWith("ig:") && !k.startsWith("ig_comment:")) return "instagram_dm";
  if (k.startsWith("fb_comment:")) return "facebook_comment";
  if (k.startsWith("ig_comment:")) return "instagram_comment";
  return "other";
}

function originLabelForAgents(ctx: ProcessIncomingContext | undefined, customerPhone: string): string {
  const o = (ctx?.leadOrigin ?? "").trim().toLowerCase();
  if (o) return o;
  const ch = ctx?.leadChannel ?? inferLeadChannel(customerPhone);
  if (ch === "whatsapp") return "whatsapp";
  if (ch === "voice") return "llamada";
  if (ch === "messenger") return "messenger";
  if (ch === "instagram_dm") return "instagram_dm";
  if (ch === "facebook_comment") return "facebook_comment";
  if (ch === "instagram_comment") return "instagram_comment";
  return "otro";
}

function isPortalEmailLead(ctx?: ProcessIncomingContext): boolean {
  return Boolean(ctx?.portalEmailLead);
}

type LeadNotifyHints = {
  ref: string | null;
  refFromListPick?: string | null;
  property?: PropertyRow;
  assignedAgent: AgentContact;
  intentType: "A" | "B" | "C";
  /** Mensaje original del cliente (sin bloques internos de contexto). */
  rawUserText: string;
};

function stripInternalContextBlocks(text: string): string {
  const cut = text.split(/\n\n\[(?:Contexto interno|Instrucciones internas)/)[0] ?? text;
  return cut.replace(/\s+/g, " ").trim();
}

function buildClientInfoForAgent(
  rawUserText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  leadScanText: string,
  currentMessageOnly = false
): string | null {
  const latestRaw = sanitizeClientInfoForAgent(stripInternalContextBlocks(rawUserText));
  const latest = isGarbageClientInfo(latestRaw) ? "" : latestRaw;
  // Email de portal: mensaje del cliente = solo el Mensaje/MENSAJE del email, sin extras inferidos.
  if (currentMessageOnly) {
    return latest.length >= 8 ? latest : null;
  }

  const dialogParts = history
        .filter((m) => m.role === "user")
        .slice(-4)
        .map((m) => sanitizeClientInfoForAgent(stripInternalContextBlocks(m.content)))
        .filter((s) => s.length >= 8 && !isGarbageClientInfo(s));
  if (latest.length >= 8 && !dialogParts.includes(latest)) dialogParts.push(latest);

  const extras: string[] = [];
  const occupation = extractOccupation(leadScanText);
  if (occupation) extras.push(`trabajo: ${occupation}`);
  const budget = extractMoneyNearKeywords(leadScanText, ["presupuesto", "hasta", "maximo", "máximo"]);
  if (budget != null) extras.push(`presupuesto: ${budget}€`);
  const income = extractMoneyNearKeywords(leadScanText, ["ingresos", "nomina", "nómina", "cobro", "salario"]);
  if (income != null) extras.push(`ingresos: ${income}€/mes`);
  const moveIn = extractMoveInTiming(leadScanText);
  if (moveIn) extras.push(`entrada: ${moveIn}`);
  if (detectWantsVisit(leadScanText)) extras.push("quiere visita");
  const guarantor = detectGuarantor(leadScanText);
  if (guarantor != null && !/\bavalista\b/.test(stripInternalContextBlocks(rawUserText).toLowerCase())) {
    extras.push(`avalista: ${guarantor ? "sí" : "no"}`);
  }

  const dialog = dialogParts.join(" | ");
  const merged = [dialog, extras.length ? extras.join(", ") : ""].filter(Boolean).join(" · ");
  if (!merged || merged.length < 8) return null;
  const max = 220;
  return merged.length > max ? `${merged.slice(0, max)}…` : merged;
}

/** Evita avisar al agente por mensajes vacíos, papeleo o temas de administración. */
function shouldNotifyAgentLead(
  normalizedText: string,
  ref: string | null,
  hasProperty: boolean,
  missedCallFollowUp: boolean,
  administrativeConversation: boolean
): boolean {
  if (missedCallFollowUp) return false;
  if (administrativeConversation) return false;
  if (wantsHumanContact(normalizedText)) return true;
  if (isGenericWhatsAppOpener(normalizedText)) return false;
  if (isPaperworkFollowUp(normalizedText)) return false;
  if (ref || hasProperty) return true;
  if (hasPropertySearchIntent(normalizedText)) return true;
  if (detectWantsVisit(normalizedText)) return true;
  if (hasClearIntent(normalizedText)) return true;
  return normalizedText.trim().length >= 40;
}

/** Avisa al agente asignado (dedup 7 d por teléfono+ref cuando se conoce la ref). */
async function notifyAgentOfContact(
  customerPhone: string,
  latestUserText: string,
  assistantReply: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  _notifyText: (to: string, body: string) => Promise<void>,
  ctx?: ProcessIncomingContext,
  hints?: LeadNotifyHints
): Promise<void> {
  const customerDigits = customerPhone.replace(/\D+/g, "");
  if (BLOCKED_CONTACT_PHONES.has(customerDigits)) {
    console.log("[lead] Contacto interno/agente; no se notifica", { customerPhone });
    return;
  }

  const portalLead = isPortalEmailLead(ctx);
  const notifyHistory = portalLead ? [] : history;
  const recentUserText = history
    .filter((x) => x.role === "user")
    .slice(-8)
    .map((x) => x.content)
    .join("\n");
  const combined = `${recentUserText}\n${latestUserText}`;
  const contactSource = portalLead ? latestUserText : combined;
  const fullHistoryText = portalLead
    ? latestUserText
    : [...history.map((x) => x.content), latestUserText].join("\n");
  const profile = portalLead ? null : getLeadProfile(customerPhone);
  const profileRef = sanitizePropertyRef(profile?.ref);
  const refFinal = portalLead
    ? resolveLeadRef(hints?.ref ?? ctx?.leadRef, latestUserText, latestUserText, [], null)
    : resolveLeadRef(hints?.ref, latestUserText, combined, history, profileRef);

  if (refFinal && hasRecentLeadNotification(customerPhone, 168, refFinal)) {
    console.log("[lead] Ya notificado al agente para esta ref (7 días); skip", {
      customerPhone,
      ref: refFinal,
    });
    return;
  }
  if (!refFinal && hasRecentLeadNotification(customerPhone, 168, null)) {
    console.log("[lead] Ya notificado al agente para este contacto sin ref (7 días); skip", {
      customerPhone,
    });
    return;
  }

  const refInReply = extractFirstRefFromAssistantReply(assistantReply) ?? extractRefFromAssistantReply(assistantReply);
  const leadScanText = portalLead
    ? latestUserText
    : refInReply
      ? `${fullHistoryText}\n\n${assistantReply}`
      : fullHistoryText;

  const extractedEmail = portalLead
    ? ctx?.leadContactEmail ?? extractPortalContactEmail(contactSource) ?? extractEmail(contactSource)
    : extractEmail(combined);
  const extractedPhone = portalLead
    ? ctx?.leadContactPhone ?? extractPortalContactPhone(contactSource) ?? extractPhoneAny(contactSource)
    : extractPhoneAny(combined);
  const emailLooksInternal = extractedEmail ? INTERNAL_EMAIL_RE.test(extractedEmail) : false;
  const hasRealContact =
    !!extractedPhone ||
    (!!extractedEmail && !emailLooksInternal && !extractedEmail.includes("@contacts.idealista.com"));
  const channel = ctx?.leadChannel ?? inferLeadChannel(customerPhone);
  const isWhatsappChannel = channel === "whatsapp" || channel === "voice";
  if (!isWhatsappChannel && !hasRealContact) {
    console.log("[lead] Sin contacto real del cliente; no se notifica", {
      customerPhone,
      channel,
      hasEmail: !!extractedEmail,
      hasPhone: !!extractedPhone,
      emailInternal: emailLooksInternal,
    });
    return;
  }

  // En canales no-WhatsApp, `customerPhone` puede ser un id técnico tipo `email:unknown:...`.
  const property =
    hints?.property ??
    (refFinal ? (await loadPropertyByRef(refFinal)) ?? searchProperties({ ref: refFinal, limit: 1 })[0] : undefined);
  const intentType = resolveLeadIntent(property, leadScanText);
  const agent = await resolveAssignedAgent(intentType, refFinal, property ?? hints?.property);
  const clientName = resolveCustomerName(
    customerPhone,
    portalLead ? latestUserText : leadScanText,
    ctx,
    notifyHistory
  );

  const emailFromScan = portalLead
    ? extractedEmail
    : extractEmail(leadScanText);
  const emailFromScanInternal = emailFromScan ? INTERNAL_EMAIL_RE.test(emailFromScan) : false;
  const email =
    emailFromScan && !emailFromScanInternal && !emailFromScan.includes("@contacts.idealista.com")
      ? emailFromScan
      : extractedEmail && !emailLooksInternal && !extractedEmail.includes("@contacts.idealista.com")
        ? extractedEmail
        : "No indicado";

  const budget = extractMoneyNearKeywords(leadScanText, ["presupuesto", "hasta", "maximo", "máximo"]);
  const monthlyIncome = extractMoneyNearKeywords(leadScanText, [
    "ingresos",
    "nomina",
    "nómina",
    "cobro",
    "salario",
  ]);
  const hasGuarantor = detectGuarantor(leadScanText);
  const wantsVisit = detectWantsVisit(leadScanText);
  const occupation = extractOccupation(leadScanText) ?? "No indicado";
  const moveIn = extractMoveInTiming(leadScanText) ?? "No indicado";
  const lastClientMessage = latestUserText.trim();

  const propertyUrl = publicPropertyUrl({ ref: refFinal ?? "", url: property?.url });

  const convPhone =
    conversationPhoneDigits(customerPhone) ?? conversationPhoneDigits(ctx?.customerDisplayId);
  const clientPhone = portalLead
    ? extractedPhone ?? convPhone ?? null
    : convPhone ?? extractedPhone ?? null;
  const clientEmail =
    email !== "No indicado"
      ? email
      : extractedEmail && !emailLooksInternal && !extractedEmail.includes("@contacts.idealista.com")
        ? extractedEmail
        : null;

  const origin =
    (ctx?.leadOrigin ?? "").trim() ||
    getMissedCallLeadOrigin(customerPhone) ||
    originLabelForAgents(ctx, customerPhone);

  if (isMissedCallPending(customerPhone)) {
    const hasName = hasValidCustomerName(clientName);
    const hasRef = Boolean(refFinal);
    if (!hasName || !hasRef) {
      console.log("[lead] Llamada perdida: esperando nombre y referencia antes de avisar al agente", {
        customerPhone,
        hasName,
        hasRef,
      });
      return;
    }
    clearMissedCallPending(customerPhone);
  }

  const channelForGate = ctx?.leadChannel ?? inferLeadChannel(customerPhone);
  const isDirectWhatsappLead =
    (channelForGate === "whatsapp" || channelForGate === "voice") && !portalLead;
  if (isDirectWhatsappLead && !portalLead && intentType !== "C") {
    if (
      !shouldNotifyWhatsappAgentLead({
        normalizedText: latestUserText,
        chosenRef: refFinal,
        customerName: clientName,
        refFromListPick: hints?.refFromListPick ?? null,
        missedCallFollowUp: false,
        administrativeConversation: false,
        nameJustProvided:
          hasValidCustomerName(clientName) && extractName(latestUserText) !== null,
        propertyPresentedInHistory: Boolean(
          refFinal &&
            history.some(
              (m) => m.role === "assistant" && m.content.includes(`(ref. ${refFinal})`),
            ),
        ),
      })
    ) {
      console.log("[lead] WhatsApp: sin nombre, ref o interés suficiente; no se notifica al agente", {
        customerPhone,
        ref: refFinal,
        hasName: hasValidCustomerName(clientName),
      });
      return;
    }
  }

  const clientInfo = isDirectWhatsappLead
    ? intentType === "C"
      ? summarizeOwnerListingIntent([
          ...notifyHistory.filter((m) => m.role === "user").map((m) => m.content),
          latestUserText,
        ])
      : summarizeWhatsappClientIntent({
        userMessages: [
          ...notifyHistory.filter((m) => m.role === "user").map((m) => m.content),
          latestUserText,
        ],
        chosenRef: refFinal,
        propertyTitle: property?.title ?? null,
        propertyLocation: property?.location ?? null,
        transactionType: property?.transaction_type ?? null,
      })
    : buildClientInfoForAgent(
        hints?.rawUserText ?? latestUserText,
        notifyHistory,
        leadScanText,
        portalLead,
      );

  const note = formatLeadForAgent({
    origin,
    name: clientName,
    phone: clientPhone,
    email: clientEmail,
    ref: refFinal,
    propertyUrl,
    clientInfo,
  });

  const leadId = insertLeadNotification({
    customerPhone,
    agentPhone: agent.phone,
    agentName: agent.name,
    ref: refFinal,
    intent: intentType,
    origin,
    summary: note,
    customerName: clientName && !isGarbageClientName(clientName) ? clientName : null,
    customerEmail: clientEmail,
  });

  const delivery = emptyDelivery();
  try {
    await trackAiAction(
      {
        source: "whatsapp",
        channelId: customerDigits || customerPhone,
        phone: customerDigits,
        tool: "avisar_comercial",
        input: { comercial: agent.name, ref: refFinal, intent: intentType, origen: origin },
      },
      async () => {
        const agentNotify = await deliverAgentLeadNotification(agent, note, { ref: refFinal });
        delivery.agent.whatsapp = agentNotify.whatsapp;
        delivery.agent.email = agentNotify.email;

        // Confirmación al cliente con datos del comercial (visita / demanda / portal con móvil).
        const phoneForClient =
          clientPhone?.replace(/\D+/g, "") ||
          (isDirectWhatsappLead ? customerDigits : "") ||
          "";
        if (phoneForClient && isLikelyWhatsappNumber(phoneForClient)) {
          const clientWaOk = await sendVoiceClientWhatsAppConfirm({
            phone: phoneForClient,
            name: clientName,
            agent,
            ref: refFinal,
            summary: clientInfo,
            property: property ?? null,
            forHandoff: true,
            leadOrigin: origin,
          });
          delivery.client.whatsapp = clientWaOk;
        } else if (clientEmail) {
          delivery.client.email = null;
          delivery.client.whatsapp = null;
        } else {
          delivery.client.whatsapp = null;
          delivery.client.email = null;
        }

        applyDeliveryChannels(leadId, delivery, {
          customerName: clientName && !isGarbageClientName(clientName) ? clientName : null,
          customerEmail: clientEmail,
          notes:
            !phoneForClient && clientEmail
              ? "Cliente sin WhatsApp válido; la respuesta al cliente va por email si aplica"
              : null,
        });

        return toDeliveryJson({
          ...delivery,
          agentName: agent.name,
          ref: refFinal,
          clientChannel: resolveClientChannel(delivery.client),
        });
      },
    );
  } catch (e) {
    applyDeliveryChannels(leadId, delivery, {
      notes: `Error en envíos: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    });
    console.error("[lead] Fallo al avisar / confirmar handoff", {
      customerPhone,
      agent: agent.name,
      error: e,
    });
  }

  upsertLeadProfile({
    customerPhone,
    name: clientName && !isGarbageClientName(clientName) ? clientName : undefined,
    email: email === "No indicado" ? null : email,
    intentType,
    ref: refFinal,
    budget,
    monthlyIncome,
    hasGuarantor,
    wantsVisit,
    extraNotes: `Trabajo: ${occupation}. Entrada: ${moveIn}. ${lastClientMessage.slice(0, 200)}`,
  });
  console.log("[lead] Contacto reenviado al agente", {
    customerPhone,
    agent: agent.name,
    ref: refFinal,
    intentType,
    channel: config.agentNotifyChannel,
    delivery,
  });
}

export async function processIncomingText(
  from: string,
  text: string,
  sendText: (to: string, body: string) => Promise<void>,
  notifyAgentText?: (to: string, body: string) => Promise<void>,
  context?: ProcessIncomingContext
): Promise<void> {
  const blocked = isBlockedByWorkSchedule();
  console.log("[whatsapp] processIncomingText entry", {
    blocked,
    fromTail: from.slice(-4),
    textLen: text.length,
  });

  if (blocked) {
    console.log("[whatsapp] Bot pausado por horario laboral (L-V 10:00-19:30 Europe/Madrid)", {
      from,
    });
    return;
  }

  const botGuard = applyBotLoopGuard(from, text);
  if (botGuard.blocked) {
    if (botGuard.farewell) {
      appendMessage(from, "user", text);
      appendMessage(from, "assistant", botGuard.farewell);
      try {
        await sendText(from, botGuard.farewell);
      } catch (e) {
        console.error("[whatsapp] Fallo al enviar despedida anti-bot", e);
      }
    } else {
      console.log("[whatsapp] Mensaje ignorado (contacto silenciado)", {
        fromTail: from.slice(-4),
        reason: botGuard.reason,
      });
    }
    return;
  }

  const normalizedText = normalizeRealEstateSynonyms(text);
  console.log("[whatsapp] Procesando mensaje", { from, preview: text.slice(0, 80) });
  let resolved = await resolvePropertyFromMessage(normalizedText);
  const contextRef = sanitizePropertyRef(context?.leadRef);
  if (!resolved.property && contextRef) {
    const fromPortal = await loadPropertyByRef(contextRef);
    if (fromPortal) {
      resolved = {
        ref: fromPortal.ref,
        property: fromPortal,
        aiContext: `${normalizedText}\n\n[Contexto interno detectado]\n- Referencia detectada: ${fromPortal.ref}\n- Operación: ${fromPortal.transaction_type ?? "No indicada"}\n- Precio: ${fromPortal.price != null ? `${fromPortal.price} €` : "No indicado"}\n- Título: ${fromPortal.title}\n- Zona: ${fromPortal.location ?? "No indicada"}\n- URL: ${fromPortal.url ?? "No disponible"}`,
      };
    } else {
      resolved = { ...resolved, ref: contextRef };
    }
  }
  const hasUntrustedUrl = extractUrls(normalizedText).some(isUntrustedExternalUrl);
  const hasExternalPortalUrl = extractUrls(normalizedText).some(isExternalPortalUrl);
  const effectiveText =
    (hasUntrustedUrl || hasExternalPortalUrl) && !resolved.property
      ? [
          normalizedText,
          "",
          "[Instrucciones internas]",
          "- El cliente ha pegado un enlace externo. Por seguridad NO abrimos ni visitamos enlaces; no digas que 'no tienes acceso' ni que 'no encontraste la referencia' como si hubieras fallado al abrirla.",
          "- Responde de forma proactiva y breve: explica que para localizarla en nuestro catálogo necesitas la referencia del anuncio (Idealista, 6–12 dígitos) O, si no la tiene, más detalles del inmueble.",
          "- Pide 1-2 datos concretos: referencia preferente; si no, zona/calle + precio aproximado + venta/alquiler (+ habitaciones si puede).",
          "- También vale el enlace de mamboinmobiliaria.com o de Idealista del anuncio si lo tiene.",
          "- NO inventes una referencia ni listes 5 propiedades al azar solo porque mandó un link.",
          "- Si en el mensaje ya hay zona/precio/tipo, úsalos para orientar, pero confirma pidiendo la ref o un dato que cierre la ficha.",
        ].join("\n")
      : resolved.aiContext;
  const prev = getMessagesForOpenAI(from);
  const history = toOpenAIHistory(prev);
  const historyUserText = prev
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const combinedSearchText = `${historyUserText}\n${normalizedText}`.trim();
  const combinedForNameEarly = combinedSearchText;
  const profileRefEarly = sanitizePropertyRef(getLeadProfile(from)?.ref);
  const refFromHistoryEarly = resolveLeadRef(
    contextRef,
    normalizedText,
    combinedForNameEarly,
    prev,
    profileRefEarly
  );
  const activeRefEarly =
    sanitizePropertyRef(resolved.ref ?? contextRef ?? extractFirstRef(normalizedText)) ??
    refFromHistoryEarly;
  const skipRepeatPropertySearch =
    Boolean(
      activeRefEarly &&
        propertyAlreadyPresentedInHistory(prev, activeRefEarly) &&
        !isNewPropertySearchMessage(normalizedText, activeRefEarly)
    );
  const searchResult =
    !resolved.property && !skipRepeatPropertySearch
      ? handleUnresolvedPropertySearch({
          combinedText: combinedSearchText,
          history: prev,
          currentText: normalizedText,
        })
      : null;

  if (searchResult?.kind === "found") {
    const p = await enrichPropertyWithAgent(searchResult.property);
    resolved = {
      ref: p.ref,
      property: p,
      aiContext: `${normalizedText}\n\n[Contexto interno detectado]\n- Referencia detectada: ${p.ref}\n- Operación: ${p.transaction_type ?? "No indicada"}\n- Precio: ${p.price != null ? `${p.price} €` : "No indicado"}\n- Título: ${p.title}\n- Zona: ${p.location ?? "No indicada"}\n- URL: ${p.url ?? "No disponible"}`,
    };
  } else if (resolved.property) {
    resolved = {
      ...resolved,
      property: await enrichPropertyWithAgent(resolved.property),
    };
  }

  const leadChannel = context?.leadChannel ?? inferLeadChannel(from);
  const combinedForName = `${historyUserText}\n${normalizedText}`.trim();
  const customerName = resolveCustomerName(from, combinedForName, context, prev);
  const profileRefRaw = sanitizePropertyRef(getLeadProfile(from)?.ref);
  const refFromListPickEarly = extractRefFromNumberedChoice(prev, normalizedText);
  const refForCurrentEarly = sanitizePropertyRef(
    resolved.ref ?? contextRef ?? extractFirstRef(normalizedText) ?? refFromListPickEarly,
  );
  const profileRefStale = isProfileRefStale(
    profileRefRaw,
    normalizedText,
    prev,
    refForCurrentEarly,
  );
  const profileRef = profileRefStale ? null : profileRefRaw;
  if (profileRefStale && profileRefRaw) {
    clearLeadProfileRef(from);
    console.log("[whatsapp] Ref de perfil antigua ignorada", { from, staleRef: profileRefRaw });
  }
  const missedCallFollowUp = isMissedCallPending(from);
  const administrativeConversation = isAdministrativeConversation(normalizedText, prev);

  const refFromHistory = resolveLeadRef(contextRef, normalizedText, combinedForName, prev, profileRef);
  const refFromListPick = refFromListPickEarly;
  const refForCurrent = refForCurrentEarly;

  upsertLeadProfile({
    customerPhone: from,
    name: hasValidCustomerName(customerName) ? customerName! : undefined,
    email: extractEmail(normalizedText),
    ref: refForCurrent ?? refFromHistory,
    intentType: resolveLeadIntent(resolved.property, normalizedText),
    budget: extractMoneyNearKeywords(normalizedText, ["presupuesto", "hasta", "maximo", "máximo"]),
    monthlyIncome: extractMoneyNearKeywords(normalizedText, ["ingresos", "nomina", "nómina", "cobro"]),
    hasGuarantor: detectGuarantor(normalizedText),
    wantsVisit: detectWantsVisit(normalizedText) ? true : null,
    ...(missedCallFollowUp
      ? {}
      : {
          extraNotes:
            `${extractOccupation(normalizedText) ?? ""} ${extractMoveInTiming(normalizedText) ?? ""} ${normalizedText.slice(0, 180)}`.trim() ||
            undefined,
        }),
  });

  const refForAgent = refForCurrent ?? refFromHistory;
  let agentProperty = resolved.property;
  if (refFromListPick && !agentProperty) {
    agentProperty =
      (await loadPropertyByRef(refFromListPick)) ??
      searchProperties({ ref: refFromListPick, limit: 1 })[0];
    if (agentProperty) {
      agentProperty = await enrichPropertyWithAgent(agentProperty);
      resolved = {
        ref: agentProperty.ref,
        property: agentProperty,
        aiContext: `${normalizedText}\n\n[Contexto interno detectado]\n- Referencia detectada: ${agentProperty.ref}\n- Operación: ${agentProperty.transaction_type ?? "No indicada"}\n- Precio: ${agentProperty.price != null ? `${agentProperty.price} €` : "No indicado"}\n- Título: ${agentProperty.title}\n- Zona: ${agentProperty.location ?? "No indicada"}\n- URL: ${agentProperty.url ?? "No disponible"}`,
      };
    }
  }
  const intentType = resolveLeadIntent(
    resolved.property ?? agentProperty,
    `${historyUserText}\n${normalizedText}`,
  );
  const assignedAgent = await resolveAssignedAgent(
    intentType,
    refForAgent,
    resolved.property ?? agentProperty,
  );
  const isFirstTurn = isFirstConversationTurn(prev);
  const isDirectWhatsApp =
    leadChannel === "whatsapp" && !context?.portalCustomerReply && !missedCallFollowUp;
  const isPortalWhatsapp = context?.portalCustomerReply === "whatsapp";
  /** WhatsApp directo: conversación natural; plantilla rígida en portal (WA/email) o al elegir ref. */
  const isPortalLead = Boolean(context?.portalCustomerReply) || isPortalEmailLead(context);
  const useStructuredReply =
    isPortalWhatsapp || isPortalLead || (isDirectWhatsApp && Boolean(refFromListPick));
  const mentionAgent =
    !administrativeConversation &&
    (shouldMentionAgentToCustomer(
      refForAgent,
      !!resolved.property,
      customerName,
      normalizedText
    ) ||
      Boolean((isPortalWhatsapp || isPortalLead) && refForAgent));

  let reply: string;

  const propertyMessageOpts = (): Omit<CustomerPropertyMessageOpts, "property" | "agent"> => ({
    customerName,
    leadOrigin: context?.leadOrigin ?? (isDirectWhatsApp ? "whatsapp" : undefined),
    withClosing: context?.portalCustomerReply === "email",
  });

  const conversationProperty =
    resolved.property ??
    (refForAgent && !profileRefStale
      ? (await loadPropertyByRef(refForAgent)) ?? searchProperties({ ref: refForAgent, limit: 1 })[0]
      : undefined);
  const propertyWasShown =
    !!conversationProperty &&
    propertyAlreadyPresentedInHistory(prev, conversationProperty.ref);
  const newPropertySearch = isNewPropertySearchMessage(
    normalizedText,
    conversationProperty?.ref ?? null
  );
  const ongoingPropertyChat = propertyWasShown && !newPropertySearch;
  const structuredFollowUp =
    ongoingPropertyChat && shouldUseStructuredPropertyFollowUp(normalizedText);
  const useOngoingPropertyAi =
    ongoingPropertyChat && !administrativeConversation && !structuredFollowUp;
  const propertyBrowseTurn = isPropertyBrowseOrSelectTurn(normalizedText);
  const mentionAgentToClient =
    mentionAgent && !(useOngoingPropertyAi && propertyBrowseTurn && !refFromListPick);

  if (useOngoingPropertyAi && conversationProperty && !resolved.property) {
    resolved = {
      ref: conversationProperty.ref,
      property: conversationProperty,
      aiContext: `${normalizedText}\n\n[Contexto interno detectado]\n- Referencia detectada: ${conversationProperty.ref}\n- Operación: ${conversationProperty.transaction_type ?? "No indicada"}\n- Precio: ${conversationProperty.price != null ? `${conversationProperty.price} €` : "No indicado"}\n- Título: ${conversationProperty.title}\n- Zona: ${conversationProperty.location ?? "No indicada"}\n- URL: ${conversationProperty.url ?? "No disponible"}`,
    };
  }

  const chosenRef =
    refFromListPick ??
    refForCurrent ??
    (propertyWasShown ? conversationProperty?.ref ?? null : null);

  const ownerListingTurn =
    isDirectWhatsApp &&
    !administrativeConversation &&
    shouldUseOwnerListingReply(normalizedText, prev);

  if (isDirectWhatsApp && isGenericWhatsAppOpener(normalizedText)) {
    reply = buildWhatsAppOpenerReply({
      isFirstTurn,
      customerName,
      activeRef: conversationProperty?.ref ?? refForAgent,
      isValidName: hasValidCustomerName,
    });
    console.log("[whatsapp] Saludo / reapertura sin cerrar hilo", { from });
  } else if (
    isDirectWhatsApp &&
    !ownerListingTurn &&
    !administrativeConversation &&
    wantsBuyerServicesDetail(normalizedText)
  ) {
    reply = [
      "Por compradores e inquilinos ofrecemos:",
      formatBuyerServicesForWhatsApp(),
      "¿Buscas compra o alquiler? Dime zona y presupuesto aproximado y te ayudo.",
    ].join("\n\n");
    console.log("[whatsapp] Servicios comprador/inquilino", { from });
  } else if (ownerListingTurn) {
    reply = buildOwnerListingReply(customerName, normalizedText, prev);
    console.log("[whatsapp] Propietario vender/alquilar", { from });
  } else if (
    isDirectWhatsApp &&
    !administrativeConversation &&
    wantsListingLink(normalizedText) &&
    conversationProperty
  ) {
    reply = formatListingLinkReply(conversationProperty);
    console.log("[whatsapp] Enlace del anuncio", { from, ref: conversationProperty.ref });
  } else if (
    isDirectWhatsApp &&
    shouldAskNameForHandoff({
      isDirectWhatsApp: true,
      chosenRef,
      customerName,
      normalizedText,
      refFromListPick,
    }) &&
    conversationProperty &&
    !refFromListPick
  ) {
    reply = buildAskNameForHandoffReply(conversationProperty, assignedAgent);
    console.log("[whatsapp] Pedir nombre antes de pasar al agente", { from, ref: chosenRef });
  } else if (refFromListPick && resolved.property && useStructuredReply && !administrativeConversation) {
    reply = formatPropertyDetailShort(
      resolved.property,
      null,
      propertyMessageOpts(),
    );
    if (!hasValidCustomerName(customerName)) {
      reply = appendAskNameIfNeeded(reply, assignedAgent);
    }
    console.log("[whatsapp] Ficha elegida de lista", { from, ref: resolved.property.ref });
  } else if (
    ongoingPropertyChat &&
    structuredFollowUp &&
    useStructuredReply &&
    !administrativeConversation &&
    conversationProperty
  ) {
    reply = buildPropertyFollowUpReply({
      userText: normalizedText,
      property: conversationProperty,
      customerName,
      agent: assignedAgent,
      mentionAgent: mentionAgentToClient,
    });
    if (
      isDirectWhatsApp &&
      !hasValidCustomerName(customerName) &&
      detectWantsVisit(normalizedText)
    ) {
      reply = appendAskNameIfNeeded(reply, assignedAgent);
    }
    console.log("[whatsapp] Seguimiento inmueble", { from, ref: conversationProperty.ref });
  } else if (isDirectWhatsApp && searchResult && !administrativeConversation) {
    if (searchResult.kind === "found" && resolved.property && !propertyWasShown) {
      reply = await generateSearchAwareReply();
    } else {
      reply = searchResult.reply;
    }
    console.log("[whatsapp] Búsqueda conversacional", { from, kind: searchResult.kind });
  } else if (useOngoingPropertyAi) {
    reply = await generateSearchAwareReply();
    console.log("[whatsapp] Conversación IA (ficha ya enviada)", { from, ref: conversationProperty?.ref });
  } else if (
    conversationProperty &&
    useStructuredReply &&
    !administrativeConversation &&
    !propertyWasShown &&
    !isDirectWhatsApp
  ) {
    reply = formatPropertyDetailShort(
      conversationProperty,
      mentionAgent ? assignedAgent : null,
      propertyMessageOpts(),
    );
    console.log("[whatsapp] Ficha corta", { from, ref: conversationProperty.ref, agent: assignedAgent.name });
  } else if (searchResult && useStructuredReply) {
    if (searchResult.kind === "found" && resolved.property && !propertyWasShown) {
      reply = formatPropertyDetailShort(
        resolved.property,
        mentionAgent ? assignedAgent : null,
        propertyMessageOpts(),
      );
    } else if (searchResult.kind !== "found") {
      reply = searchResult.reply;
    } else {
      reply = await generateSearchAwareReply();
    }
    console.log("[whatsapp] Respuesta corta búsqueda", { from, kind: searchResult.kind });
  } else {
    reply = await generateSearchAwareReply();
  }

  if (mentionAgentToClient && !administrativeConversation) {
    reply = ensureAssignedAgentContact(reply, assignedAgent);
  }

  async function generateSearchAwareReply(opts?: { ownerListing?: boolean }): Promise<string> {
    try {
      const language = detectLanguage(text);
      const prop = resolved.property ?? conversationProperty;
      return await generateAssistantReply(
        useOngoingPropertyAi ? normalizedText : effectiveText,
        history,
        from,
        {
          language,
          contactChannel: leadChannel,
          customerName,
          skipRag: !!prop,
          portalCustomerReply: context?.portalCustomerReply,
          missedCallFollowUp,
          administrativeConversation,
          mentionAgentToCustomer: mentionAgentToClient && !opts?.ownerListing,
          firstWhatsAppTurn: isDirectWhatsApp && isFirstTurn && !isGenericWhatsAppOpener(normalizedText),
          propertySearchPending: !prop && !propertyBrowseTurn && !opts?.ownerListing,
          ongoingPropertyConversation: useOngoingPropertyAi && !propertyBrowseTurn,
          ongoingPropertyRef: propertyBrowseTurn ? null : prop?.ref ?? refForAgent,
          directWhatsappColloquial: isDirectWhatsApp,
          ownerListingIntent: opts?.ownerListing ?? ownerListingTurn,
          ...(mentionAgentToClient && prop && !opts?.ownerListing
            ? {
                assignedAgent: {
                  name: assignedAgent.name,
                  phone: assignedAgent.phone,
                  ref: refForAgent,
                },
              }
            : {}),
        },
      );
    } catch (e) {
      console.error("[whatsapp] OpenAI error", e);
      return "Ahora mismo tengo un problema técnico al responder. Por favor escribe al 644 601 999 o a info@mamboinmobiliaria.com.";
    }
  }

  console.log("[whatsapp] Respuesta generada", { from, preview: reply.slice(0, 80) });

  appendMessage(from, "user", text);
  appendMessage(from, "assistant", reply);

  console.log("[whatsapp] Enviando respuesta", { to: from });
  await sendText(from, reply);
  console.log("[whatsapp] Respuesta enviada", { to: from });

  try {
    const notifyRef = chosenRef ?? refForAgent;
    const nameJustProvided =
      hasValidCustomerName(customerName) && extractName(normalizedText) !== null;
    const userMsgs = [
      ...prev.filter((m) => m.role === "user").map((m) => m.content),
      text,
    ];
    const ownerListingConversation =
      isDirectWhatsApp &&
      (isOwnerListingIntent(normalizedText) || userMsgs.some((m) => isOwnerListingIntent(m)));

    const shouldNotify = !administrativeConversation && (
      missedCallFollowUp
        ? true
        : ownerListingConversation
          ? shouldNotifyOwnerListingLead(normalizedText, customerName, userMsgs)
          : isDirectWhatsApp
            ? shouldNotifyWhatsappAgentLead({
              normalizedText,
              chosenRef: notifyRef,
              customerName,
              refFromListPick,
              missedCallFollowUp: false,
              administrativeConversation,
              nameJustProvided,
              propertyPresentedInHistory: Boolean(
                notifyRef && propertyAlreadyPresentedInHistory(prev, notifyRef),
              ),
            })
            : shouldNotifyAgentLead(
              normalizedText,
              notifyRef,
              !!resolved.property,
              false,
              administrativeConversation,
            )
    );
    if (!shouldNotify) {
      console.log("[lead] Sin lead cualificado; no se notifica al agente", {
        from,
        isDirectWhatsApp,
        chosenRef: notifyRef,
        hasName: hasValidCustomerName(customerName),
      });
      return;
    }
    await notifyAgentOfContact(from, text, reply, prev, notifyAgentText ?? sendText, context, {
      ref: ownerListingConversation ? null : notifyRef,
      refFromListPick,
      property: resolved.property ?? conversationProperty,
      assignedAgent,
      intentType,
      rawUserText: text,
    });
  } catch (e) {
    console.error("[lead] Error al notificar al agente", e);
  }
}

