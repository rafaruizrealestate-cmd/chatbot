import { config } from "../config.js";

/** Saludo fijo en el primer mensaje de WhatsApp sin consulta concreta. */
export function whatsappFirstGreeting(): string {
  return `Hola, soy ${config.botName} la IA de ${config.agencyName}. ¿Cómo puedo ayudarte?`;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Primer turno: aún no hay historial en la conversación. */
export function isFirstConversationTurn(
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  return history.length === 0;
}

const GREETING_OPENER_RE =
  /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|hello|hi|saludos)(?:\s|[!.?,]|$)/;

/** Apertura genérica: solo saludos explícitos, sin tratar mensajes cortos al azar. */
export function isGenericWhatsAppOpener(text: string): boolean {
  const t = normalize(text).trim();
  if (!t) return true;
  const propertySignal =
    /\b(ref\.?|referencia|\d{3,4}\b|\d{6,12}\b|piso|chalet|atico|duplex|adosado|parcela|terreno|alquiler|compr|visita|habitacion|dormitori|vivienda|casa|barat|m2|m²|€|euros|millon|precio|zona|velez|torre del mar|almayate|periana|mijas|marbella|malaga|fuengirola|torremolinos|benalmadena|estepona|seguimos|gracias|pagar|fianza|deposito|dep[oó]sito)\b/i.test(
      text,
    );
  if (propertySignal) return false;
  if (!GREETING_OPENER_RE.test(t)) return false;
  // Saludo + consulta concreta → no es opener puro.
  if (t.length > 45) return false;
  if (/\b(quiero|busco|interesad|visita|ref|piso|casa|alquil|compr|vender|precio|zona)\b/.test(t)) {
    return false;
  }
  return true;
}

/** Saludo o reapertura sin cerrar ni resetear el hilo activo. */
export function buildWhatsAppOpenerReply(opts: {
  isFirstTurn: boolean;
  customerName?: string | null;
  activeRef?: string | null;
  isValidName?: (name: string | null | undefined) => boolean;
}): string {
  if (opts.isFirstTurn || !opts.activeRef) {
    return whatsappFirstGreeting();
  }
  const validName =
    opts.customerName?.trim() &&
    (opts.isValidName ? opts.isValidName(opts.customerName) : true);
  const hi = validName ? `Hola, ${opts.customerName!.trim()}.` : "Hola.";
  return `${hi} ¿Seguimos con el inmueble ref. ${opts.activeRef} o buscas otra cosa?`;
}

export function shouldMentionAgentToCustomer(
  ref: string | null | undefined,
  hasProperty: boolean,
  customerName: string | null | undefined,
  userText: string
): boolean {
  void customerName;
  if (/\b(visita|hablar con|persona|humano|agente|comercial|llamad|contacto directo)\b/i.test(userText)) {
    return true;
  }
  if (ref || hasProperty) return true;
  return false;
}
