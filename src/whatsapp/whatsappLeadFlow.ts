import type { PropertyRow } from "../knowledge/properties.js";
import { resolvePropertyRefFromCatalog } from "../knowledge/properties.js";
import type { AgentContact } from "../agents/assignment.js";
import { formatAgentPhoneEs } from "../leads/agentNotification.js";
import { isGarbageClientName } from "../utils/portalLeadText.js";
import {
  extractRefFromNumberedChoice,
  extractPropertySearchSignals,
  hasPropertySearchIntent,
  isNewPropertySearchMessage,
  propertyAlreadyPresentedInHistory,
} from "./propertySearch.js";
import { isOwnerListingIntent } from "./intent.js";
import {
  formatOwnerServicesForWhatsApp,
  wantsOwnerServicesDetail,
} from "../knowledge/services.js";

export const OWNER_REGISTRATION_URL =
  "https://www.inmobiliariabazan.com/registro-vendedor.php";
export const OWNER_CONTACT = { name: "Álvaro", phone: "34646424563" };

const GREETING_AS_NAME = new Set([
  "hola",
  "buenas",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
  "hey",
  "hello",
  "hi",
  "saludos",
  "vale",
  "ok",
  "si",
  "sí",
]);

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function hasValidCustomerName(name: string | null | undefined): boolean {
  if (!name?.trim()) return false;
  if (isGarbageClientName(name)) return false;
  const n = normalize(name);
  if (GREETING_AS_NAME.has(n)) return false;
  if (n.length < 2 || n.length > 60) return false;
  if (/^\d+$/.test(n)) return false;
  return true;
}

export function detectWantsVisit(text: string): boolean {
  return /\b(visita|visitar|visitarla|verlo|verla|quiero verlo|ver la|esta semana|cuanto antes|mañana|coordinar(?:\s+la)?\s+visita|agendar(?:\s+una)?\s+visita)\b/i.test(
    text,
  );
}

export function wantsHumanContact(text: string): boolean {
  return /\b(ponme en contacto|hablar con (un )?(agente|comercial|persona|humano)|quiero hablar|contacto con (un )?(agente|comercial))\b/i.test(
    text,
  );
}

/** El cliente quiere pasar a manos del comercial (visita, más info, elección de ficha…). */
export function detectWhatsappHandoffInterest(
  text: string,
  refFromListPick?: string | null,
): boolean {
  if (refFromListPick) return true;
  if (detectWantsVisit(text)) return true;
  if (wantsHumanContact(text)) return true;
  if (
    /\b(me interesa|me gusta (esta|esa|la)|quiero (más|mas) info|más información|más detalles|mas informacion|mas detalles|que me llam|que me contact|hablar con|coordinar|visitarla|verla)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(el|la|numero|n[uú]mero)\s*(\d+|primero|segundo|tercero|cuarto)\b/i.test(text)) {
    return true;
  }
  if (resolvePropertyRefFromCatalog(text)) return true;
  return false;
}

export function isPropertySearchCorrection(text: string): boolean {
  return /\b(no es|eso es|esto es|incorrecto|equivocad|te (he )?dich|yo te (he )?dich|me has (pasado|enviado|mandado))\b/i.test(
    text,
  );
}

/** Ref guardada en perfil de otra conversación: no usarla si el cliente busca otra cosa. */
export function isProfileRefStale(
  profileRef: string | null,
  normalizedText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  explicitRef: string | null,
): boolean {
  if (!profileRef) return false;
  if (explicitRef === profileRef) return false;
  if (resolvePropertyRefFromCatalog(normalizedText) === profileRef) return false;
  if (extractRefFromNumberedChoice(history, normalizedText) === profileRef) return false;
  if (isPropertySearchCorrection(normalizedText)) return true;
  if (isNewPropertySearchMessage(normalizedText, profileRef)) return true;
  if (!propertyAlreadyPresentedInHistory(history, profileRef) && hasPropertySearchIntent(normalizedText)) {
    return true;
  }
  return false;
}

export function shouldNotifyWhatsappAgentLead(opts: {
  normalizedText: string;
  chosenRef: string | null;
  customerName: string | null;
  refFromListPick: string | null;
  missedCallFollowUp: boolean;
  administrativeConversation: boolean;
  /** El cliente acaba de dar su nombre tras ver una ficha. */
  nameJustProvided?: boolean;
  propertyPresentedInHistory?: boolean;
}): boolean {
  if (opts.missedCallFollowUp || opts.administrativeConversation) return false;
  if (!opts.chosenRef) return false;
  if (!hasValidCustomerName(opts.customerName)) return false;

  if (opts.nameJustProvided && opts.propertyPresentedInHistory) {
    return true;
  }

  return detectWhatsappHandoffInterest(opts.normalizedText, opts.refFromListPick);
}

export function shouldAskNameForHandoff(opts: {
  isDirectWhatsApp: boolean;
  chosenRef: string | null;
  customerName: string | null;
  normalizedText: string;
  refFromListPick: string | null;
}): boolean {
  if (!opts.isDirectWhatsApp || !opts.chosenRef) return false;
  if (hasValidCustomerName(opts.customerName)) return false;
  return detectWhatsappHandoffInterest(opts.normalizedText, opts.refFromListPick);
}

export function buildAskNameSuffix(agent?: AgentContact | null): string {
  const agentName = agent?.name?.trim() ?? "tu comercial";
  return `¿Me dices tu nombre completo para que ${agentName} pueda contactarte?`;
}

export function buildAskNameForHandoffReply(
  property: PropertyRow,
  agent?: AgentContact | null,
): string {
  const agentName = agent?.name?.trim() ?? "tu comercial";
  return `¡Perfecto! Para que ${agentName} pueda ayudarte con ${property.title} (ref. ${property.ref}), ¿me dices tu nombre completo?`;
}

export function appendAskNameIfNeeded(
  reply: string,
  agent?: AgentContact | null,
): string {
  if (/\bnombre\b/i.test(reply)) return reply;
  return `${reply.trim()}\n\n${buildAskNameSuffix(agent)}`;
}

/**
 * Si el modelo nombró al comercial sin teléfono, añade la línea con Telf.
 * Si no menciona al comercial y hay handoff, también la añade.
 */
export function ensureAssignedAgentContact(
  reply: string,
  agent: AgentContact | null | undefined,
): string {
  if (!agent?.name?.trim() || !agent.phone?.trim()) return reply;
  const phoneDigits = agent.phone.replace(/\D+/g, "");
  const local9 =
    phoneDigits.startsWith("34") && phoneDigits.length >= 11
      ? phoneDigits.slice(2)
      : phoneDigits;
  const phoneDisplay = formatAgentPhoneEs(agent.phone);
  const compact = reply.replace(/\D+/g, "");
  const hasPhone =
    (local9.length >= 9 && compact.includes(local9)) ||
    reply.includes(phoneDisplay);

  if (hasPhone) return reply;

  const name = agent.name.trim();
  const line = `Tu comercial es ${name}, Telf: ${phoneDisplay}. Por favor contáctale por su WhatsApp o, si prefieres, llámalo, para coordinar una visita.`;
  return `${reply.trim()}\n\n${line}`;
}

function isTrivialUserMessage(text: string): boolean {
  const t = normalize(text);
  if (t.length < 4) return true;
  if (GREETING_AS_NAME.has(t)) return true;
  if (/^(si|sí|ok|vale|perfecto|gracias|de acuerdo)$/.test(t)) return true;
  return false;
}

/** Resumen legible para el agente: qué busca y qué ha elegido el cliente por WhatsApp. */
export function summarizeWhatsappClientIntent(opts: {
  userMessages: string[];
  chosenRef: string | null;
  propertyTitle?: string | null;
  propertyLocation?: string | null;
  transactionType?: string | null;
}): string {
  const messages = opts.userMessages.map((m) => m.trim()).filter((m) => !isTrivialUserMessage(m));
  const combined = messages.join(" ");
  const signals = combined ? extractPropertySearchSignals(combined) : null;

  const tx =
    opts.transactionType?.toLowerCase() === "venta"
      ? "compra"
      : opts.transactionType?.toLowerCase() === "alquiler"
        ? "alquiler"
        : signals?.transactionType === "Venta"
          ? "compra"
          : signals?.transactionType === "Alquiler"
            ? "alquiler"
            : null;

  const zone =
    opts.propertyLocation?.split(" en ")[0]?.trim() ??
    signals?.location ??
    null;

  const parts: string[] = [];

  if (tx && zone) {
    parts.push(`Busca ${tx} en ${zone}.`);
  } else if (tx) {
    parts.push(`Busca ${tx}.`);
  } else if (zone) {
    parts.push(`Interés en ${zone}.`);
  }

  if (opts.chosenRef) {
    const label = opts.propertyTitle
      ? `${opts.propertyTitle} (ref. ${opts.chosenRef})`
      : `ref. ${opts.chosenRef}`;
    parts.push(`Ha elegido ${label}.`);
  }

  if (detectWantsVisit(combined)) {
    parts.push("Quiere visitar el inmueble.");
  } else if (wantsHumanContact(combined)) {
    parts.push("Pide hablar con un comercial.");
  } else if (detectWhatsappHandoffInterest(combined, opts.chosenRef)) {
    parts.push("Solicita más información o que le contacte el comercial.");
  }

  if (parts.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1]!;
    const snippet = last.length > 140 ? `${last.slice(0, 140)}…` : last;
    parts.push(`Consulta: «${snippet}».`);
  }

  const summary = parts.join(" ").trim();
  if (!summary) return "Consulta por WhatsApp.";
  return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
}

export function isOffTopicFromOwnerFlow(text: string): boolean {
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (isOwnerListingIntent(text)) return false;
  if (/^(gracias|ok|vale|perfecto|genial|de acuerdo|entendido)\b/.test(t)) return true;
  if (/\b(seguimos con ese|que tiene que ver|qué tiene que ver|no entiendo|nada que ver)\b/.test(t)) {
    return true;
  }
  if (
    /\b(cuanto|cuánto)\s+(es|sale|da)\b/.test(t) &&
    /\d+\s*[x×*]\s*\d+|dos por dos|resultado/.test(t)
  ) {
    return true;
  }
  if (
    /\b(busco|buscar|me gusta|interesado en|quiero ver|visitar)\b/.test(t) &&
    !/\bmi (piso|casa|inmueble|propiedad)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function hasRecentOwnerListingContext(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): boolean {
  const userMsgs = history.filter((m) => m.role === "user").slice(-4);
  if (userMsgs.some((m) => isOwnerListingIntent(m.content))) return true;
  const lastAssistant =
    [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return /registro-vendedor\.php|WhatsApp Álvaro/i.test(lastAssistant);
}

function isOwnerListingFollowUp(text: string): boolean {
  if (isOffTopicFromOwnerFlow(text)) return false;
  if (isOwnerListingIntent(text)) return true;
  if (wantsOwnerServicesDetail(text)) return true;
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /\b(zona|barrio|m2|m²|habitacion|planta|metros|calles?|malaga|vender|alquiler|venta|tasacion|exclusiva|registro|formulario|local|amueblad)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(esta|está|es en|queda en|en el|en la)\b/.test(t) && t.length < 120) return true;
  return t.length <= 80 && !/\b(ref\.?\s*\d{3,4}|busco piso|en venta en|en alquiler en)\b/.test(t);
}

/** Rama propietario solo en mensaje actual o seguimiento coherente (no temas ajenos). */
export function shouldUseOwnerListingReply(
  normalizedText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): boolean {
  if (isOwnerListingIntent(normalizedText)) return true;
  if (isOffTopicFromOwnerFlow(normalizedText)) return false;
  if (!hasRecentOwnerListingContext(history)) return false;
  return isOwnerListingFollowUp(normalizedText);
}

const OWNER_CALLBACK_RE =
  /\b(que me llame|que me llamen|llamadme|ll[aá]mame|llamenme|ll[aá]menme|contactadme|contact[ae]nme|que (me )?contacte|que se ponga en contacto|prefiero que me llam|me pod[eé]is llamar|podeis llamarme|que me telefonee)\b/i;

const OWNER_ANNOYED_RE =
  /\b(otra vez|ya te (lo )?(he )?dicho|ya lo dije|te lo (he )?dicho|repites|repite|lo mismo|me lo has dicho)\b/i;

function ownerZoneOrDetailsGiven(text: string): boolean {
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\d+\s*(hab|habitacion|dormitor|m2|m²|metros)/.test(t)) return true;
  if (/\b(centro|perchel|trinidad|teatinos|limonar|el palo|pedregalejo|churriana|huelin|carranque|cruz de humilladero|ciudad jardin|victoria|martiricos|soho|malagueta|este|capuchinos|cerrado de calderon)\b/.test(t)) {
    return true;
  }
  if (/\b(en el |en la |en |zona de |barrio de |calle )\b/.test(t) && /\b(malaga|centro|piso|casa|chalet|local)\b/.test(t)) {
    return true;
  }
  return false;
}

function ownerOperationLabel(combined: string): string | null {
  const t = combined
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const venta = /\b(vender|vendo|venta|traspas)\w*/.test(t);
  const alquiler = /\b(alquilar|alquilo|alquiler|arrend)\w*/.test(t) && !/\bni alquiler\b/.test(t);
  if (venta && !alquiler) return "vender";
  if (alquiler && !venta) return "alquilar";
  return null;
}

function buildOwnerHandoffConfirmation(
  customerName: string | null | undefined,
  combinedText: string,
): string {
  const hi = hasValidCustomerName(customerName) ? `Perfecto, ${customerName!.trim()}. ` : "Perfecto. ";
  const op = ownerOperationLabel(combinedText);
  const opNote = op ? ` para ${op} tu inmueble` : "";
  return [
    `${hi}Le paso tus datos a ${OWNER_CONTACT.name}${opNote} y se pone en contacto contigo lo antes posible.`,
    `Si prefieres, escríbele tú directamente por WhatsApp: +34 646 424 563`,
    `O registra el inmueble aquí para agilizar: ${OWNER_REGISTRATION_URL}`,
  ].join("\n\n");
}

/**
 * Respuesta a propietario, contextual:
 * - Pide que le llamen / está molesto / ya dio zona-detalles → confirmación de handoff (no re-preguntar).
 * - Pregunta cómo trabajáis / servicios → lista de servicios + contacto.
 * - Primer contacto → intro breve + contacto + 1 pregunta.
 */
export function buildOwnerListingReply(
  customerName?: string | null,
  userText?: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  const text = userText ?? "";
  const recentUser = (history ?? [])
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => m.content);
  const combined = [...recentUser, text].join(" ");
  const alreadyAskedZone = (history ?? []).some(
    (m) => m.role === "assistant" && /¿En qué zona está/i.test(m.content),
  );

  const wantsCallback = OWNER_CALLBACK_RE.test(text);
  const annoyed = OWNER_ANNOYED_RE.test(text);
  const detailsGiven = ownerZoneOrDetailsGiven(text) || ownerZoneOrDetailsGiven(combined);

  if (wantsCallback || annoyed || (alreadyAskedZone && detailsGiven)) {
    return buildOwnerHandoffConfirmation(customerName, combined);
  }

  const hi = hasValidCustomerName(customerName) ? `Gracias, ${customerName!.trim()}. ` : "";
  if (wantsOwnerServicesDetail(text)) {
    return [
      `${hi}Te resumo cómo trabajamos con propietarios:`,
      formatOwnerServicesForWhatsApp(),
      `Te orienta ${OWNER_CONTACT.name} (WhatsApp +34 646 424 563). Registro: ${OWNER_REGISTRATION_URL}`,
      "¿En qué zona está el inmueble y prefieres venta o alquiler?",
    ].join("\n\n");
  }

  return [
    `${hi}Si quieres que gestionemos la venta o el alquiler de tu inmueble, ${OWNER_CONTACT.name} te orienta.`,
    `WhatsApp ${OWNER_CONTACT.name}: +34 646 424 563`,
    `Registro online: ${OWNER_REGISTRATION_URL}`,
    "¿En qué zona está el inmueble y prefieres venta o alquiler?",
  ].join("\n\n");
}

export function summarizeOwnerListingIntent(userMessages: string[]): string {
  const messages = userMessages.map((m) => m.trim()).filter((m) => !isTrivialUserMessage(m));
  const combined = messages.join(" ");
  const parts: string[] = ["Propietario: quiere gestionar venta o alquiler con la inmobiliaria."];
  if (/\bventa\b/i.test(combined) && !/\balquiler\b/i.test(combined)) {
    parts.push("Operación: venta.");
  } else if (/\balquiler\b/i.test(combined) && !/\bventa\b/i.test(combined)) {
    parts.push("Operación: alquiler.");
  }
  const last = messages[messages.length - 1];
  if (last && last.length >= 8) {
    const snippet = last.length > 140 ? `${last.slice(0, 140)}…` : last;
    parts.push(`Dice: «${snippet}».`);
  }
  return parts.join(" ");
}

export function shouldNotifyOwnerListingLead(
  normalizedText: string,
  customerName: string | null,
  userMessages: string[],
): boolean {
  if (!isOwnerListingIntent(normalizedText) && !userMessages.some((m) => isOwnerListingIntent(m))) {
    return false;
  }
  if (hasValidCustomerName(customerName)) return true;
  const substantive = userMessages
    .map((m) => m.trim())
    .filter((m) => !isTrivialUserMessage(m) && m.length >= 20);
  return substantive.length >= 1;
}
