import type { FetchedEmail } from "./imapClient.js";
import { extractPropertyRefFromText } from "../utils/propertyRef.js";
import {
  extractPortalContactName,
  extractPortalContactPhone,
  extractPortalContactEmail,
  isContactPlaceholderValue,
  isGarbageClientName,
  isGarbageCustomerEmail,
  scrubCorporatePhonesFromText,
  scrubUrlsFromText,
} from "../utils/portalLeadText.js";
import {
  extractPhoneFromText,
  isBlockedCorporatePhone,
  parsePhoneToE164Digits,
} from "../utils/phone.js";

export type PortalOrigin = "idealista" | "fotocasa" | "habitatsoft" | null;

/** Dominios/emisores de portales o sistema: nunca usar como email del cliente para responder. */
export function isPortalOrSystemEmailAddress(addr: string): boolean {
  const lower = addr.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at === -1) return false;
  const host = lower.slice(at + 1);
  const local = lower.slice(0, at);
  const hostHints = [
    "idealista.com",
    "fotocasa",
    "webphone.net",
    "inmobiliariabazan.com",
    "inmobiliariabazan.es",
    "pisos.com",
    "indomio",
    "habitatsoft.com",
    "habitatsoft.",
    "gestion.habitatsoft",
    "yaencontre",
    "habitaclia",
    "milanuncios",
    "mailgun.org",
    "sendgrid.net",
    "amazonaws.com",
    "egorealestate.com",
    "newsletter.egorealestate",
  ];
  if (hostHints.some((h) => host.includes(h))) return true;
  if (host.includes("contacts.idealista.com")) return true;
  if (/^(no-?reply|noreply|donotreply|mailer-daemon|postmaster|bounce)/i.test(local)) return true;
  return false;
}

function extractEmailAddressFromHeader(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const bracketed = trimmed.match(/<([^>]+)>/);
  const addr = (bracketed?.[1] ?? trimmed).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}

/** Buzón propio de la inmobiliaria: nunca auto-responder (evita bucles). */
export function isOwnMailboxAddress(addr: string): boolean {
  return isPortalOrSystemEmailAddress(addr) && /@inmobiliariabazan\.(com|es)$/i.test(addr.trim());
}

export function isOwnMailboxFromHeader(from: string): boolean {
  const addr = extractEmailAddressFromHeader(from);
  return addr ? isOwnMailboxAddress(addr) : false;
}

function collectAddressesFromMailparserField(field: unknown): string[] {
  if (!field) return [];
  if (typeof field === "string") {
    const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    return Array.from(field.matchAll(re), (x) => x[0]);
  }
  const f = field as { value?: Array<{ address?: string }>; text?: string };
  if (Array.isArray(f.value)) {
    return f.value
      .map((v) => (typeof v.address === "string" ? v.address.trim() : ""))
      .filter(Boolean);
  }
  if (typeof f.text === "string") {
    const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    return Array.from(f.text.matchAll(re), (x) => x[0]);
  }
  return [];
}

export type ClassifiedEmail = {
  portal: PortalOrigin;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  propertyRef: string | null;
  messageText: string;
  originalSubject: string;
  isAdvertisement: boolean;
  /** Llamada perdida de portal (Idealista, Pisos.com…): solo teléfono, sin ref ni nombre. */
  isMissedCall: boolean;
  /** Procedencia legible para el agente (idealista, fotocasa, pisos.com, indomio…). */
  leadOrigin: string;
  /** Spam/phishing detectado: no auto-responder (evita legitimar estafas). */
  suppressAutoReply: boolean;
  suppressReason?: string | null;
};

const FROM_RULES: Array<{ pattern: RegExp; portal: PortalOrigin }> = [
  { pattern: /idealista\.com/i, portal: "idealista" },
  { pattern: /fotocasa/i, portal: "fotocasa" },
  { pattern: /gestion\.habitatsoft\.com/i, portal: "habitatsoft" },
  { pattern: /habitatsoft\.com/i, portal: "habitatsoft" },
  { pattern: /webphone\.net/i, portal: "habitatsoft" },
  { pattern: /pisos\.com/i, portal: "habitatsoft" },
  { pattern: /indomio/i, portal: "habitatsoft" },
  { pattern: /habitatsoft/i, portal: "habitatsoft" },
];

function identifyPortal(from: string, subject: string): PortalOrigin {
  const combined = `${from} ${subject}`.toLowerCase();
  for (const rule of FROM_RULES) {
    if (rule.pattern.test(combined)) return rule.portal;
  }
  return null;
}

/** Origen detallado para el aviso al agente. */
export function resolveLeadOrigin(portal: PortalOrigin, from: string, subject: string, body: string): string {
  const t = `${from} ${subject} ${body}`.toLowerCase();
  if (/pisos\.com/.test(t)) return "pisos.com";
  if (/indomio/.test(t)) return "indomio";
  if (portal) return portal;
  return "email";
}

export function isMissedCallEmail(from: string, subject: string, body: string): boolean {
  const t = `${subject}\n${body}`.toLowerCase();
  return (
    /llamada\s+no\s+contestada/i.test(t) ||
    /llamada\s+perdida/i.test(t) ||
    /notificaci[oó]n\s+de\s+llamada\s+perdida/i.test(t) ||
    (/no\s+contestada/i.test(t) && /interesado\s+en\s+tus\s+anuncios/i.test(t)) ||
    (/has\s+recibido\s+una\s+llamada\s+perdida/i.test(t) &&
      /n[uú]mero\s+de\s+tel[eé]fono/i.test(t))
  );
}

function normalizeSpanishMobile(digits: string): string {
  const d = digits.replace(/\D+/g, "");
  if (d.length === 9 && /^[67]/.test(d)) return `34${d}`;
  return d;
}

/** Teléfono del interesado en avisos de llamada perdida (no el de redirección ni servicio). */
function extractCallerPhoneForMissedCall(text: string): string | null {
  const patterns = [
    /(?:interesado\s+)?llam[oó]\s+desde\s+([+\d\s().-]{9,22})/i,
    /n[uú]mero\s+desde\s+el\s+que\s+te\s+han\s+llamado[:\s]+([+\d\s().-]{9,22})/i,
    /llamada\s+perdida\s+del\s+n[uú]mero\s+de\s+tel[eé]fono\s+(\d{9,15})/i,
    /ha(?:s)?\s+recibido\s+una\s+llamada\s+perdida\s+del\s+n[uú]mero(?:\s+de\s+tel[eé]fono)?\s+(\d{9,15})/i,
    /notificaci[oó]n\s+de\s+llamada\s+perdida\s+del\s+n[uú]mero\s+(\d{9,15})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1]) continue;
    const d = normalizeSpanishMobile(m[1]);
    if (d.length >= 9 && d.length <= 15) return d;
  }
  return null;
}

function isContactPlaceholder(value: string): boolean {
  return isContactPlaceholderValue(value);
}

function scrubInternalPhoneLines(text: string): string {
  return text
    .replace(/servicio\s+utilizado[:\s]+[\d\s]+/gi, " ")
    .replace(/tel[eé]fono\s+de\s+redirecci[oó]n[:\s]+[\d\s]+/gi, " ")
    .replace(/recibida\s+en\s+el\s+tel[eé]fono[^.\n]*/gi, " ")
    .replace(/duraci[oó]n\s+en\s+segundos[:\s]+\d+/gi, " ")
    .replace(/ll[aá]manos al[\s\d]+(?:\[tel:[^\]]+\])?/gi, " ")
    .replace(/\[tel:\+?34900823825\]/gi, " ");
}

function extractLabeledPhone(text: string): string | null {
  const patterns = [
    /(?:^|\n)\s*t[eé]lefono[:\s]+([^\n]+)/im,
    /(?:^|\n)\s*phone[:\s]+([^\n]+)/im,
    /tel[eé]fono\s+de\s+contacto[:\s]+([^\n]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1] || isContactPlaceholder(m[1])) continue;
    const fromLine = parsePhoneToE164Digits(m[1]);
    if (fromLine) return fromLine;
  }
  return null;
}

function extractPhone(text: string): string | null {
  const fromPortalBlock = extractPortalContactPhone(text);
  if (fromPortalBlock) return fromPortalBlock;

  const scrubbed = scrubCorporatePhonesFromText(scrubInternalPhoneLines(scrubUrlsFromText(text)));

  const labeled = extractLabeledPhone(scrubbed);
  if (labeled && !isBlockedCorporatePhone(labeled)) return labeled;

  return extractPhoneFromText(scrubbed);
}

/** Primer correo en el texto que no sea de portales/sistema (mismo criterio que Idealista/Fotocasa). */
function extractCustomerEmailFromText(text: string): string | null {
  const fromPortal = extractPortalContactEmail(text);
  if (fromPortal) return fromPortal;

  const labeled = text.match(/(?:^|\n)\s*email[:\s]+([^\n]+)/im);
  if (labeled?.[1] && !isContactPlaceholder(labeled[1])) {
    const addr = labeled[1].trim().toLowerCase();
    if (!isPortalOrSystemEmailAddress(addr)) return addr;
  }

  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const addr = m[0].trim().toLowerCase();
    if (isGarbageCustomerEmail(addr)) continue;
    if (!isPortalOrSystemEmailAddress(addr)) return addr;
  }
  return null;
}

function extractName(text: string, portal?: PortalOrigin): string | null {
  const fromPortal = extractPortalContactName(text);
  if (fromPortal) return fromPortal;

  const patterns = [
    /(?:Hola,?\s+soy|Me llamo)\s+([A-Za-zÁÉÍÓÚÑáéíóúñÅÄÖåäöüÜß' -]{2,40})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const n = m?.[1]?.trim();
    if (n && !isGarbageClientName(n)) return n;
  }
  return portal ? extractPortalContactName(text) : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAdvertisementEmail(from: string, subject: string, body: string): boolean {
  if (isMissedCallEmail(from, subject, body)) return false;

  const t = `${from}\n${subject}\n${body}`.toLowerCase();
  const promoSignals = [
    "newsletter",
    "newsletter.egorealestate",
    "egorealestate.com",
    "boletín",
    "suscripción",
    "suscripcion",
    "promoción",
    "promocion",
    "oferta",
    "descuento",
    "rebaja",
    "campaña",
    "campana",
    "publicidad",
    "publicitario",
    "marketing",
    "recomendaciones para ti",
    "novedades",
    "no respondas a este mensaje",
    "enviado por un proceso automático",
    "enviado por un proceso automatico",
    "altas comisiones",
    "captar viviendas",
    "club de agentes",
    "vipsocial",
    "presupuesto de renders",
    "control de duplicados",
    "resumen semanal",
    "los cambios de precios de tu competencia",
    "los nuevos destacados de tu competencia",
  ];
  const leadSignals = [
    "nuevo contacto",
    "nuevos mensajes",
    "esperan tu respuesta",
    "te ha dejado un contacto",
    "datos de la persona interesada",
    "datos del interesado",
    "tienes una nueva solicitud",
    "mensaje:",
    "ref.",
    "referencia",
    "código del anuncio",
    "codigo del anuncio",
    "gestionar contacto",
    "gestionar la solicitud",
    "solicitud de contacto",
    "nueva solicitud",
    "nueva petición",
    "nueva peticion",
    "petición de información",
    "peticion de informacion",
    "consulta desde",
    "mensaje desde el portal",
    "lead de",
    "nuevo mensaje",
    "buenas noticias",
  ];

  const hasPromo = promoSignals.some((s) => t.includes(s));
  const hasLead = leadSignals.some((s) => t.includes(s));
  return hasPromo && !hasLead;
}

/**
 * Correos que no deben recibir respuesta automática del bot (phishing, spam marcado, señuelos típicos).
 */
export function suppressAutoReplyReason(from: string, subject: string, body: string): string | null {
  const subj = (subject || "").toLowerCase();
  const text = `${subject}\n${body}`.toLowerCase();
  const fromLower = (from || "").toLowerCase();

  if (/\*\*\*spam\*\*\*|\*\*spam\*\*|\[spam\]|\[junk\]|\bjunk\s+mail\b/i.test(subject)) {
    return "subject_marked_spam";
  }
  if (/^\s*spam\s*:/i.test(subj.trim()) || /\bphishing\b|\bspam\s+detected\b/i.test(subj)) {
    return "subject_phishing_spam";
  }

  if (
    fromLower.includes("mailer-daemon") ||
    fromLower.includes("postmaster") ||
    fromLower.includes("mail delivery system") ||
    fromLower.includes("mailchannels.net")
  ) {
    return "bounce_mailer_daemon";
  }

  if (isOwnMailboxFromHeader(from)) {
    return "own_mailbox_loop";
  }

  if (
    /^re:\s*/i.test(subj) &&
    /hola,?\s+soy (leo|manuel|lara)(?:\s+la\s+ia)? de inmobiliaria baz[aá]n/i.test(text)
  ) {
    return "own_auto_reply_echo";
  }

  if (fromLower.includes("ahrefs.com") || text.includes("ahrefs") || text.includes("site audit") || text.includes("health score")) {
    return "non_lead_ahrefs";
  }
  if (fromLower.includes("inmoweb") || text.includes("inmoweb") || text.includes("software inmobiliario")) {
    return "non_lead_inmoweb";
  }
  if (text.includes("informe de publicación") || text.includes("informe de publicacion") || text.includes("informe de publicación de anuncios")) {
    return "non_lead_publication_report";
  }
  if (
    /control de duplicados/i.test(text) &&
    (fromLower.includes("idealista.com") || text.includes("col.idealista.com"))
  ) {
    return "non_lead_idealista_duplicate_control";
  }
  if (
    fromLower.includes("egorealestate") ||
    fromLower.includes("newsletter.egorealestate") ||
    (/ego\s+(crm|real\s+estate)|inmofocus/i.test(fromLower) &&
      /newsletter|webinar|demostraci[oó]n|campañas|nunca\s+más\s+pierdas\s+un\s+lead/i.test(text))
  ) {
    return "non_lead_egorealestate_newsletter";
  }
  if (/cambio\s+de\s+precio\s+en\s+tus\s+favoritos/i.test(text)) {
    return "non_lead_idealista_favorites";
  }
  if (/llamada\s+atendida\s+de\s+un\s+interesado/i.test(text)) {
    return "non_lead_idealista_call_attended";
  }
  if (/inicio\s+de\s+sesi[oó]n\s+fallido/i.test(text)) {
    return "non_lead_fotocasa_login";
  }
  if (fromLower.includes("wetransfer.com") || /te ha enviado.*wetransfer/i.test(text)) {
    return "non_lead_wetransfer";
  }
  if (
    /\b(altas comisiones|club de agentes|viviendas compartidas|te damos las viviendas|captar viviendas|presupuesto de renders)\b/i.test(
      text,
    ) &&
    !/\b(nuevo mensaje|contacto para|interesado en|ref[.:]?\s*\d{3,5}|buenas noticias)\b/i.test(text)
  ) {
    return "advertisement_b2b";
  }

  const passwordTopic = /contraseña|contraseña de tu cuenta|password|clave de acceso|clave de correo/i.test(
    text,
  );
  const expiryLure =
    passwordTopic &&
    (/caduc|caduca|caducidad|expir|vence pronto|expire|expiration|will expire|actualiz.*contraseña|renov.*contraseña/i.test(
      text,
    ) ||
      /notificación de caducidad|password expiration|account.*expir/i.test(text));
  const clickToKeepPassword =
    passwordTopic &&
    /conserve su contraseña|mantener.*contraseña|keep (your )?password|haga clic|click (here|the|below)|pulse el bot[oó]n/i.test(
      text,
    );

  if (expiryLure || clickToKeepPassword) {
    return "phishing_password_expiry";
  }

  if (
    /mensaje del servidor|server notification|mail server message/i.test(text) &&
    /inmobiliariabazan\.com/i.test(text) &&
    (passwordTopic || /cuenta de correo|email account|mailbox/i.test(text))
  ) {
    return "phishing_server_notification";
  }

  return null;
}

export function shouldSuppressAutoReply(from: string, subject: string, body: string): boolean {
  return suppressAutoReplyReason(from, subject, body) != null;
}

export function classifyEmail(email: FetchedEmail): ClassifiedEmail {
  const portal = identifyPortal(email.from, email.subject);
  const body = email.text || stripHtml(email.html);
  const combined = `${email.subject}\n${body}`;
  const isMissedCall = isMissedCallEmail(email.from, email.subject, body);
  const leadOrigin = resolveLeadOrigin(portal, email.from, email.subject, body);

  const replyToCandidates = collectAddressesFromMailparserField(email.parsed.replyTo);
  const customerFromReplyTo =
    replyToCandidates.find((a) => !isPortalOrSystemEmailAddress(a))?.toLowerCase() ?? null;
  const customerEmail = customerFromReplyTo ?? extractCustomerEmailFromText(combined);

  const customerPhone = isMissedCall
    ? extractCallerPhoneForMissedCall(combined) ?? extractPhone(scrubInternalPhoneLines(combined))
    : extractPhone(combined);

  const suppressReason = suppressAutoReplyReason(email.from, email.subject, body);

  return {
    portal,
    customerName: isMissedCall ? null : extractName(combined, portal),
    customerPhone,
    customerEmail: isMissedCall ? null : customerEmail,
    propertyRef: isMissedCall ? null : extractPropertyRefFromText(combined),
    messageText: combined.trim().slice(0, 8000),
    originalSubject: email.subject,
    isAdvertisement: isAdvertisementEmail(email.from, email.subject, body),
    isMissedCall,
    leadOrigin,
    suppressAutoReply: suppressReason != null,
    suppressReason,
  };
}
