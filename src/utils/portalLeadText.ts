import { scrubRefSourceText } from "./propertyRef.js";
import { isBlockedCorporatePhone, parsePhoneToE164Digits } from "./phone.js";

const GARBAGE_NAME_RE =
  /^(tienes|buenas|nuevo|nueva|respuesta|preferida|fotocasa|idealista|pisos|whatsapp|contacto|gestionar|anuncio|imagen|origen|cliente|estimad|datos|interesad)/i;

/** Nombres que no deben mostrarse al agente. */
export function isGarbageClientName(name: string | null | undefined): boolean {
  const t = (name ?? "").trim();
  if (t.length < 2) return true;
  const lower = t.toLowerCase();
  if (GARBAGE_NAME_RE.test(lower)) return true;
  if (/\btienes\s+un(a)?\b/.test(lower)) return true;
  if (/\bnuevo(s)?\s+mensaje/.test(lower)) return true;
  if (/\b(buenas\s+noticias|esperándote|esperandote)\b/.test(lower)) return true;
  if (/\btienes\s+nuevos?\s+mensajes?\b/.test(lower)) return true;
  if (/^datos\s+del\b/.test(lower)) return true;
  if (/^datos\s+de\s+la\b/.test(lower)) return true;
  if (/^(muchas\s+)?gracias\b/.test(lower)) return true;
  if (/^hola\s+(muchas\s+)?gracias\b/.test(lower)) return true;
  if (/^ver\s+perfil\b/.test(lower)) return true;
  if (/^acceder\b/.test(lower)) return true;
  if (/fotocasa\s*pro/i.test(lower)) return true;
  if (/^gestionar\s+contacto\b/.test(lower)) return true;
  if (/^buenas\s+noticias\b/.test(lower)) return true;
  if (/^foto\s+del\s+inmueble\b/.test(lower)) return true;
  if (/^logo\b/.test(lower)) return true;
  if (/^nuevo[\p{L}]/iu.test(lower)) return true;
  if (/^he encontrado estas/i.test(lower)) return true;
  if (/^hoy me llamas/i.test(lower)) return true;
  if (/^llamada\s+atendida/i.test(lower)) return true;
  if (/^agendar\s+una\s+demostraci[oó]n/i.test(lower)) return true;
  if (/^capital\s+m[aá]laga$/i.test(lower)) return true;
  if (/^m[aá]laga\s+capital/i.test(lower)) return true;
  if (/^persona\s+est[aá]\s+interesada/i.test(lower)) return true;
  if (/@|https?:|\d{5,}/.test(t)) return true;
  return false;
}

/** Texto que no debe ir en «mensaje del cliente» del lead al agente. */
export function isGarbageClientInfo(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (t.length < 8) return true;
  const lower = t.toLowerCase();
  if (isGarbageClientName(t)) return true;
  if (/^he encontrado estas\b/i.test(lower)) return true;
  if (/¿cu[aá]l te interesa/i.test(lower)) return true;
  if (/^tienes un nuevo mensaje que espera/i.test(lower)) return true;
  if (/^nuevo mensaje de\b/i.test(lower)) return true;
  if (/\bver perfil\b/i.test(lower) && t.length < 120) return true;
  if (/consultar si .+ est[aá] en una lista de morosos/i.test(lower)) return true;
  if (/responder desde idealista/i.test(lower)) return true;
  if (/^ver perfil\b/i.test(lower)) return true;
  if (/^acceder al anuncio/i.test(lower)) return true;
  if (/^gestionar (la solicitud|contacto)/i.test(lower)) return true;
  if (/^datos de la persona interesada/i.test(lower)) return true;
  if (/^datos del interesad/i.test(lower)) return true;
  if (/fotocasa_pro_logo|frtassets\.fotocasa/i.test(lower)) return true;
  if (/^llamada no contestada/i.test(lower)) return true;
  if (/^llamada\s+atendida/i.test(lower)) return true;
  if (/col\.idealista\.com/i.test(lower)) return true;
  return false;
}

function isPlausiblePersonName(name: string): boolean {
  const t = name.trim();
  if (t.length < 2 || t.length > 50) return false;
  if (isGarbageClientName(t)) return false;
  return /^[\p{L}\p{M}][\p{L}\p{M}0-9.'_-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}0-9.'_-]*){0,3}$/u.test(t);
}

/** Valores de ficha portal que no son datos reales del cliente. */
export function isContactPlaceholderValue(value: string): boolean {
  return /no\s+especificad|no\s+indicad|sin\s+tel[eé]fono|sin\s+email|n\/a|^—$|^-$/i.test(
    value.trim(),
  );
}

function cleanLabeledFieldValue(raw: string): string {
  return (
    raw
      .trim()
      .split(/\s+(?:e-?mail|tel[eé]fono|phone|fecha\s+de\s+contacto|fecha|mensaje|ref(?:erencia)?)\b/i)[0]
      ?.trim()
      .split(/\s{2,}|\t/)[0]
      ?.trim() ?? ""
  );
}

/** Quita URLs para que un móvil dentro del enlace (p. ej. tracking pisos.com) no se use como teléfono del cliente. */
export function scrubUrlsFromText(text: string): string {
  return text.replace(/https?:\/\/[^\s)\]>]+/gi, " ");
}

/** Teléfonos corporativos / redirección que no son del cliente. */
export function scrubCorporatePhonesFromText(text: string): string {
  return text
    .replace(/servicio\s+utilizado[:\s]+[\d\s]+/gi, " ")
    .replace(/tel[eé]fono\s+de\s+redirecci[oó]n[:\s]+[\d\s]+/gi, " ")
    .replace(/recibida\s+en\s+el\s+tel[eé]fono[^.\n]*/gi, " ")
    .replace(/mensaje\s+de\s+whatsapp\s+en\s+el\s+n[uú]mero[^.\n]*/gi, " ")
    .replace(/\b672\s*594\s*724\b/g, " ")
    .replace(/\b851\s*813\s*840\b/g, " ")
    .replace(/\b900\s*823\s*825\b/g, " ")
    .replace(/\[tel:\+?34900823825\]/gi, " ")
    .replace(/ll[aá]manos al[\s\d]+(?:\[tel:[^\]]+\])?/gi, " ");
}

function extractPisosInterestedBlock(text: string): string | null {
  const m = text.match(/datos del interesad[oa][^\n]{0,900}/i);
  return m?.[0] ?? null;
}

function extractFotocasaInterestedBlock(text: string): string | null {
  const m = text.match(/datos de la persona interesada[\s\S]{0,1400}/iu);
  return m?.[0] ?? null;
}

function extractFotocasaContactNameFromBlock(fotocasa: string): string | null {
  const m = fotocasa.match(
    /\bnombre[\s:\t]*(.+?)(?=tel[eé]fono|email|d[ií]a y hora|mensaje\b|$)/iu
  );
  if (!m?.[1]) return null;
  const n = cleanLabeledFieldValue(m[1]);
  if (isContactPlaceholderValue(n)) return null;
  return isPlausiblePersonName(n) ? n : null;
}

function extractPhoneFromFotocasaBlock(fotocasa: string): string | null {
  const m = fotocasa.match(/tel[eé]fono\s*:\s*([^\n]+)/iu);
  if (!m?.[1]) return null;
  const raw = cleanLabeledFieldValue(m[1].split(/(?=\s*email\s*:)/i)[0] ?? m[1]);
  if (isContactPlaceholderValue(raw)) return null;
  const digits = parsePhoneToE164Digits(raw);
  if (digits && !isBlockedCorporatePhone(digits)) return digits;
  return null;
}

function looksLikeFotocasaContactEmail(text: string): boolean {
  return (
    /fotocasa|frtassets\.fotocasa/i.test(text) &&
    /(?:datos de la persona interesada|nuevo contacto de fotocasa|nuevo mensaje esper[aá]ndote|le interesa tu anuncio|persona est[aá] interesada en el anuncio|buenas noticias.*interesad)/i.test(
      text
    )
  );
}

/** Nombre en emails Fotocasa tipo chat («NuevoSophie12/06/2026» o «Sophie 12/06/2026 - 22:26»). */
function extractFotocasaChatName(text: string): string | null {
  const glued = text.match(/Nuevo([\p{L}\p{M}][\p{L}\p{M}'-]{0,40})\d{2}\/\d{2}\/\d{4}/iu);
  if (glued?.[1]) {
    const n = glued[1].trim();
    if (isPlausiblePersonName(n)) return n;
  }
  const line = text.match(
    /(?:^|\n)\s*([\p{L}\p{M}][\p{L}\p{M}'-]{0,40})\s+\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}:\d{2}/imu
  );
  if (line?.[1]) {
    const n = line[1].trim();
    if (isPlausiblePersonName(n)) return n;
  }
  return null;
}

/** Mensaje en emails Fotocasa tipo chat (sin bloque «Datos de la persona interesada»). */
function extractFotocasaChatMessage(text: string): string | null {
  const block = text.match(
    /Nuevo[\p{L}\p{M}][^\n]*\n([\s\S]{15,900}?)(?:\n\s*(?:Tel[eé]fono de contacto:|Responder \[|Mensajes anteriores))/iu
  );
  if (!block?.[1]) return null;
  let m = block[1].replace(/\s+/g, " ").trim();
  m = stripFotocasaMessageFooter(m);
  if (m.length >= 12) return m.slice(0, 220);
  return null;
}

function stripFotocasaMessageFooter(message: string): string {
  return message
    .replace(/\s+tel[eé]fono(?:\s+de\s+contacto)?\s*:?\s*[\d\s+()-]+\.?\s*$/i, "")
    .replace(/\s+Referencia\s+\d{3,5}\.?\s*$/, "")
    .replace(/\s+referencia\s*:\s*\d{3,5}\.?\s*$/i, "")
    .trim();
}

function isIdealistaProxyEmail(addr: string): boolean {
  return addr.toLowerCase().includes("@contacts.idealista.com");
}

/** Email que no es del cliente (logos, relays de portal, newsletters). */
export function isGarbageCustomerEmail(addr: string): boolean {
  const lower = addr.trim().toLowerCase();
  if (!lower.includes("@")) return true;
  const at = lower.indexOf("@");
  const local = lower.slice(0, at);
  const host = lower.slice(at + 1);
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(host)) return true;
  if (/^(png|jpe?g|gif|webp|svg|ico)$/i.test(host.split(".").pop() ?? "")) return true;
  if (/logo|fotocasa_pro|social_media|@2x\./i.test(lower)) return true;
  if (/^(social_media|ic[_-]|logo|badge)/i.test(local)) return true;
  if (/frtassets\.|static\.fotocasa|chat\.fotocasa\.es/i.test(lower)) return true;
  if (lower === "cliente@fotocasa.pro") return true;
  if (/newsletter\.|noreply@newsletter/i.test(lower)) return true;
  if (/egorealestate|imobiliario@newsletter/i.test(lower)) return true;
  if (/idealista\.com|fotocasa\.es|pisos\.com|webphone\.net|habitatsoft/i.test(lower)) return true;
  if (isIdealistaProxyEmail(lower)) return true;
  return false;
}

function isFotocasaSupportTelContext(text: string, index: number): boolean {
  const ctx = text.slice(Math.max(0, index - 120), index + 40).toLowerCase();
  return (
    /ll[aá]manos al|cliente@fotocasa|atenci[oó]n telef[oó]nica|¿tienes dudas/.test(ctx) ||
    /\b900\s*823/.test(ctx)
  );
}

function extractTelLinkPhone(text: string): string | null {
  for (const m of text.matchAll(/\[tel:(\+?[\d\s().-]+)\]/gi)) {
    if (isFotocasaSupportTelContext(text, m.index ?? 0)) continue;
    const digits = parsePhoneToE164Digits(m[1]!);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }
  return null;
}

/** Teléfono real del interesado en emails Idealista (`[tel:+34…]` en la ficha de contacto). */
export function extractIdealistaContactPhone(text: string): string | null {
  for (const m of text.matchAll(/\[tel:(\+?[\d\s().-]+)\]/gi)) {
    const digits = parsePhoneToE164Digits(m[1]!);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }
  return null;
}

/** Email real del interesado (excluye relay `@contacts.idealista.com`). */
export function extractPortalContactEmail(text: string): string | null {
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const addr = m[0].trim().toLowerCase();
    if (isGarbageCustomerEmail(addr)) continue;
    return addr;
  }
  return null;
}

/** Mensaje del cliente en emails Idealista (antes de «Responder desde idealista»). */
function extractIdealistaClientMessage(t: string): string | null {
  const m = t.match(
    /(?:consultar\s+si\s+[\p{L}\p{M}\s]+\s+est[aá]\s+en\s+una\s+lista\s+de\s+morosos\s*)?(.{8,220}?)\s*responder\s+desde\s+idealista/iu
  );
  if (!m?.[1]) return null;
  const msg = m[1].replace(/\s+/g, " ").trim();
  if (msg.length < 8 || /^consultar\b/i.test(msg)) return null;
  if (isGarbageClientInfo(msg)) return null;
  return msg.slice(0, 220);
}

/** Teléfono del interesado en emails pisos.com / habitatsoft (bloque «Datos del interesado»). */
export function extractPortalContactPhone(text: string): string | null {
  if (looksLikeFotocasaContactEmail(text)) {
    const fotocasaBlock = extractFotocasaInterestedBlock(text);
    if (fotocasaBlock) {
      const fromFotocasa = extractPhoneFromFotocasaBlock(fotocasaBlock);
      return fromFotocasa;
    }
  }

  const telLink = extractTelLinkPhone(text);
  if (telLink) return telLink;

  const idealista = extractIdealistaContactPhone(text);
  if (idealista) return idealista;

  const pisos = extractPisosInterestedBlock(text);
  if (pisos) {
    const tel = pisos.match(/\bt[eé]lefono[\s:\t]+(.+?)(?:\s+fecha|\s+mensaje|\s+gestionar|$)/i);
    if (tel?.[1]) {
      const digits = parsePhoneToE164Digits(tel[1]);
      if (digits && !isBlockedCorporatePhone(digits)) return digits;
    }
  }

  const labeled = text.match(/\bt[eé]lefono[\s:\t]+(.+?)(?:\s+fecha|\s+mensaje|\n|$)/im);
  if (labeled?.[1]) {
    const digits = parsePhoneToE164Digits(labeled[1]);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }
  return null;
}

function extractIdealistaNameFromIntro(text: string): string | null {
  const patterns = [
    /(?:nuevo\s+mensaje|respuesta|oferta)(?:\s*\([^)]*\))?\s+de\s+((?:[\p{L}\p{M}][\p{L}\p{M}'._-]*\s*){1,4})\s+sobre\b/iu,
    /\bde\s+((?:[\p{L}\p{M}][\p{L}\p{M}'._-]*\s*){1,4})\s+sobre\s+tu\s+inmueble\b/iu,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const n = m[1].trim().replace(/\s+/g, " ");
    if (isPlausiblePersonName(n)) return n;
  }
  return null;
}

function looksLikeIdealistaContactEmail(text: string): boolean {
  return (
    /\bidealista\.com\b/i.test(text) &&
    /(?:nuevo\s+mensaje|respuesta\s+de|oferta\s+de|\bde\s+[\p{L}\p{M}].{2,60}\s+sobre\s+tu\s+inmueble)/iu.test(
      text
    )
  );
}

/** Nombre en ficha Idealista: línea propia antes de «Ver perfil» o teléfono. */
function extractIdealistaNameBeforeContactBlock(text: string): string | null {
  const m = text.match(
    /(?:^|\n)\s*((?:[\p{L}\p{M}][\p{L}\p{M}'._-]*\s*){1,4})\s*(?:\n\s*)+(?:Ver\s+perfil|\[?\s*tel:|(?:\+?34|34)?[\s.-]?[67]\d{2}[\s.-]\d{3})/imu
  );
  if (!m?.[1]) return null;
  const n = m[1].trim().replace(/\s+/g, " ");
  return isPlausiblePersonName(n) ? n : null;
}

/** Nombre del interesado en emails de portales. */
export function extractPortalContactName(text: string): string | null {
  if (looksLikeIdealistaContactEmail(text)) {
    const fromIntro = extractIdealistaNameFromIntro(text);
    if (fromIntro) return fromIntro;
    const fromBody = extractIdealistaNameBeforeContactBlock(text);
    if (fromBody) return fromBody;
  }

  if (looksLikeFotocasaContactEmail(text)) {
    const fotocasaBlock = extractFotocasaInterestedBlock(text);
    if (fotocasaBlock) {
      const fromBlock = extractFotocasaContactNameFromBlock(fotocasaBlock);
      if (fromBlock) return fromBlock;
    }
    const fromChat = extractFotocasaChatName(text);
    if (fromChat) return fromChat;
    const intro = text.match(/\bA\s+([\p{L}\p{M}][\p{L}\p{M}0-9._-]{0,40})\s+le\s+interesa\b/iu);
    if (intro?.[1] && isPlausiblePersonName(intro[1].trim())) return intro[1].trim();
  }

  const fotocasa = extractFotocasaInterestedBlock(text);
  if (fotocasa) {
    const fromFotocasa = extractFotocasaContactNameFromBlock(fotocasa);
    if (fromFotocasa) return fromFotocasa;
  }

  const pisos = extractPisosInterestedBlock(text);
  if (pisos) {
    const pisosName = pisos.match(/\bnombre[\s:\t]+(.+?)(?:\s+e-?mail|\s+tel[eé]fono|\s+fecha|\s+mensaje|$)/i);
    if (pisosName?.[1]) {
      const n = cleanLabeledFieldValue(pisosName[1]);
      if (isPlausiblePersonName(n)) return n;
    }
  }

  const labeled = text.match(/\bnombre[\s:\t]+(.+?)(?:\s+e-?mail|\s+tel[eé]fono|\s+fecha|\s+mensaje|\n|$)/im);
  if (labeled?.[1]) {
    const n = cleanLabeledFieldValue(labeled[1]);
    if (isPlausiblePersonName(n)) return n;
  }

  const idealistaName = extractIdealistaNameFromIntro(text);
  if (idealistaName) return idealistaName;

  const idealistaBodyName = extractIdealistaNameBeforeContactBlock(text);
  if (idealistaBodyName) return idealistaBodyName;

  const fotocasaIntro = text.match(
    /\bA\s+([\p{L}\p{M}][\p{L}\p{M}0-9._-]{1,40})\s+le\s+interesa\b/iu
  );
  if (fotocasaIntro?.[1]) {
    const n = fotocasaIntro[1].trim();
    if (isPlausiblePersonName(n)) return n;
  }

  const phoneRe = /(?:\+?34[\s.-]?)?[67]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}/;
  const phoneMatch = text.match(phoneRe);
  if (phoneMatch?.index && phoneMatch.index > 1) {
    const before = text.slice(0, phoneMatch.index);
    const lines = before
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (isPlausiblePersonName(line)) return line;
    }
  }

  return null;
}

/** Contraoferta Idealista: precio propuesto + mensaje del cliente. */
function extractIdealistaCounterOfferClientInfo(t: string): string | null {
  const priceMatch = t.match(/Ha\s+propuesto\s+un\s+precio\s+de:?\s*([\d.\s]+(?:€)?)/i);
  if (!priceMatch?.[1]) return null;

  const price = priceMatch[1].replace(/\s+/g, " ").trim();
  let clientText = t.slice(priceMatch.index! + priceMatch[0].length).trim();
  clientText = clientText
    .replace(/\s*responder\s+desde\s+idealista.*/i, "")
    .replace(/\s*ref\.\s+.*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const parts = [`Contraoferta: ${price}`];
  if (clientText.length >= 8 && !/^responder\b/i.test(clientText)) {
    parts.push(/^hola\b/i.test(clientText) ? clientText : `Hola, ${clientText}`);
  }
  const merged = parts.join(". ");
  return merged.length >= 8 ? merged.slice(0, 220) : null;
}

/** Mensaje del cliente en emails pisos.com (bloque MENSAJE con comillas). */
function extractPisosClientMessage(t: string): string | null {
  const block = t.match(
    /\bMENSAJE\b[\s:\t]*(.+?)(?:\s+GESTIONAR LA SOLICITUD|\s+Anuncio contactado)/u
  );
  if (!block?.[1]) return null;
  const m = block[1]
    .replace(/^[""«""'\s]+|[""»""'\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (m.length >= 8) return m.slice(0, 220);
  return null;
}

/** Mensaje del cliente en emails Fotocasa (bloque «Datos de la persona interesada»). */
function extractFotocasaClientMessage(t: string): string | null {
  const fotocasa = extractFotocasaInterestedBlock(t);
  if (!fotocasa) return null;

  const msg = fotocasa.match(
    /\bmensaje\s*:\s*([\s\S]+?)(?:\n\s*(?:\[https?:|\[tel:|whatsapp|llamar|email\s*\[|gestionar contacto|tambi[eé]n puedes)|$)/iu
  );
  if (!msg?.[1]) return null;

  let m = msg[1]
    .replace(/\s+(?:whatsapp|llamar|email|gestionar contacto).*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  m = stripFotocasaMessageFooter(m);
  if (m.length >= 8) return m.slice(0, 220);
  return null;
}

/** Texto útil para el agente: sin URLs de tracking ni cuerpo completo del email. */
export function sanitizeClientInfoForAgent(text: string): string {
  const idealistaOfferRaw = extractIdealistaCounterOfferClientInfo(text);
  if (idealistaOfferRaw) return idealistaOfferRaw;

  const idealistaClientMsgRaw = extractIdealistaClientMessage(text);
  if (idealistaClientMsgRaw) return idealistaClientMsgRaw;

  const pisosClientMsgRaw = extractPisosClientMessage(text);
  if (pisosClientMsgRaw) return pisosClientMsgRaw;

  const fotocasaClientMsgRaw = extractFotocasaClientMessage(text);
  if (fotocasaClientMsgRaw) return fotocasaClientMsgRaw;

  const fotocasaChatMsgRaw = extractFotocasaChatMessage(text);
  if (fotocasaChatMsgRaw) return fotocasaChatMsgRaw;

  let t = scrubRefSourceText(text);
  t = t
    .replace(/\[https?:\/\/[^\]]+\]/gi, " ")
    .replace(/https?:\/\/[^\s)\]>]+/gi, " ")
    .replace(/\[[^\]]{20,}\]/g, " ")
    .replace(/🤩|📩|✅|📞|🏠/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const idealistaOffer = extractIdealistaCounterOfferClientInfo(t);
  if (idealistaOffer) return idealistaOffer;

  const idealistaVisit = t.match(
    /Hola,?\s*me interesa este piso y me gustar[ií]a hacer una visita\.?(?:\s*Un saludo)?/i
  );
  if (idealistaVisit?.[0]) return idealistaVisit[0].replace(/\s+/g, " ").trim().slice(0, 220);

  const idealistaVisitShort = t.match(/Me gustar[ií]a hacer una visita/i);
  if (idealistaVisitShort?.[0]) return idealistaVisitShort[0];

  const idealistaVisitEn = t.match(
    /Hi,?\s*I['']m interested in this flat[^.]{0,160}\.?/i
  );
  if (idealistaVisitEn?.[0]) return idealistaVisitEn[0].replace(/\s+/g, " ").trim().slice(0, 220);

  const idealistaCustom = t.match(/Me interesa,\s*teletrabajo[^.]{5,200}/i);
  if (idealistaCustom?.[0]) return idealistaCustom[0].replace(/\s+/g, " ").trim().slice(0, 220);

  const idealistaCustomEn = t.match(
    /Hi,?\s*I.m interested in this flat and would like to arrange a viewing[^.]{0,80}/i
  );
  if (idealistaCustomEn?.[0]) return idealistaCustomEn[0].replace(/\s+/g, " ").trim().slice(0, 220);

  const idealistaClientMsg = extractIdealistaClientMessage(t);
  if (idealistaClientMsg) return idealistaClientMsg;

  const pisosClientMsg = extractPisosClientMessage(t);
  if (pisosClientMsg) return pisosClientMsg;

  const fotocasaStandardMsg = t.match(
    /Estoy buscando en Fotocasa y me gustar[ií]a recibir m[aá]s informaci[oó]n sobre (?:el inmueble|este inmueble)[^.]{0,120}\.?/i
  );
  if (fotocasaStandardMsg?.[0]) return fotocasaStandardMsg[0].replace(/\s+/g, " ").trim().slice(0, 220);

  // Requiere «Mensaje:» con dos puntos; evita el boilerplate «ningún mensaje de WhatsApp» de pisos.com.
  const mensaje = t.match(/\bmensaje\s*:\s*(.+?)(?:\s+fecha\s+de\s+contacto|\s+gestionar|$)/i);
  if (mensaje?.[1]) {
    const m = mensaje[1].trim();
    if (m.length >= 8) return m.slice(0, 220);
  }

  const pisosMsg = t.match(
    /datos del interesad[oa][\s\S]{0,400}?\bmensaje\s*:\s*(.+?)(?:\s+ref(?:erencia)?|\s+gestionar|$)/i
  );
  if (pisosMsg?.[1]) {
    const m = pisosMsg[1].replace(/\s+/g, " ").trim();
    if (m.length >= 8) return m.slice(0, 220);
  }

  const solicitud = t.match(/nueva solicitud de tu[^.]{10,160}/i);
  if (solicitud?.[0]) return solicitud[0].replace(/\s+/g, " ").slice(0, 220);

  t = t.replace(/^tienes un nuevo mensaje que espera tu respuesta\s*/i, "");
  t = t.replace(/\bresponder desde idealista\b.*/i, "");
  t = t.replace(/\bver perfil\b.*/i, "");
  t = t.replace(
    /^(?:🤩\s*)?(?:buenas noticias,?\s*)?(?:tienes un[a]?\s+)?(?:nuevo mensaje|respuesta|oferta)(?:\s*\([^)]*\))?(?:\s+de\s+[\p{L}\p{M}0-9._-]+\s+sobre\s+tu\s+inmueble)?[^.]{0,240}?\s*/iu,
    ""
  );
  const trimmed = t.slice(0, 220).trim();
  if (!trimmed || isGarbageClientInfo(trimmed)) return "";
  return trimmed;
}
