import { fetchRecentEmails, fetchUnseenEmails, markAsRead, type FetchedEmail } from "./imapClient.js";
import { sendEmailReply } from "./smtpSender.js";
import { buildReplyThreadingHeaders } from "./threading.js";
import { classifyEmail, isOwnMailboxAddress, type ClassifiedEmail } from "./classifier.js";
import { resetPollSendCount } from "./emailGuards.js";
import { markMissedCallPending, isMissedCallPending, markLatestLeadClientDelivery } from "../db/leads.js";
import { isAlreadyHandled } from "./crossReference.js";
import { getEmailStateByUid, insertEmailState, isSameStoredEmail } from "../db/emailState.js";
import { processIncomingText } from "../whatsapp/processIncomingText.js";
import {
  isLikelyWhatsappNumber,
  isProactiveWhatsAppAllowed,
  sendOutboundWhatsAppText,
} from "../whatsapp/outbound.js";
import { isWhatsappNotRegisteredError } from "../whatsapp/evolutionSender.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import { appendMessage } from "../db/conversations.js";
import { CUSTOMER_PROPERTY_CLOSING } from "../whatsapp/customerPropertyMessage.js";
import { config } from "../config.js";
import { ingestPortalMappingsFromText, rememberPortalListing, extractPortalAdRef } from "../knowledge/portalListings.js";

const CUSTOMER_CLOSING_MESSAGE = CUSTOMER_PROPERTY_CLOSING;

function missedCallOutreachMessage(): string {
  return `Hola, has llamado a Inmobiliaria Bazán y no pudimos atenderte porque estamos fuera de nuestro horario de atención. Nuestro horario es de 10:00 a 19:30 de lunes a viernes. Soy ${config.botName}, IA de la inmobiliaria. ¿Me dices cómo te llamas y qué inmueble te interesa —referencia o enlace de la ficha—? Si no deseas que te contactemos por WhatsApp, indícanoslo y no volveremos a escribirte por aquí.`;
}

function appendCustomerClosing(body: string, _forEmail: boolean): string {
  if (!body.trim()) return body;
  if (body.includes(CUSTOMER_CLOSING_MESSAGE)) return body.trim();
  return `${body.trim()}\n\n${CUSTOMER_CLOSING_MESSAGE}`;
}

function buildReplySubject(original: string): string {
  if (/^re:/i.test(original)) return original;
  return `Re: ${original}`;
}

function isGarantiayaSender(from: string): boolean {
  const t = (from || "").toLowerCase();
  return (
    t.includes("operaciones@garantiaya.es") ||
    t.includes("administracion@garantiaya.es")
  );
}

/** Llamada perdida de portal: contactar por WhatsApp y pedir nombre + inmueble antes del lead al agente. */
type MissedCallOutcome =
  | "sent"
  | "already_pending"
  | "no_phone"
  | "invalid_phone"
  | "whatsapp_not_registered"
  | "whatsapp_failed"
  | "proactive_disabled";

async function handleMissedCallEmail(
  email: FetchedEmail,
  classified: ClassifiedEmail,
): Promise<MissedCallOutcome> {
  if (!isProactiveWhatsAppAllowed()) {
    console.log("[email] Llamada perdida: outreach WhatsApp desactivado (solo responde a quien escriba)", {
      uid: email.uid,
      portal: classified.leadOrigin,
    });
    return "proactive_disabled";
  }

  const phone = classified.customerPhone;
  if (!phone) {
    console.log("[email] Llamada perdida sin teléfono del interesado; no se puede contactar", {
      uid: email.uid,
      portal: classified.leadOrigin,
    });
    return "no_phone";
  }

  if (!isLikelyWhatsappNumber(phone)) {
    console.log("[email] Llamada perdida: teléfono no apto para WhatsApp", {
      uid: email.uid,
      phone,
      portal: classified.leadOrigin,
    });
    return "invalid_phone";
  }

  if (isMissedCallPending(phone)) {
    console.log("[email] Llamada perdida: ya hay outreach pendiente para este teléfono", {
      uid: email.uid,
      phone,
    });
    return "already_pending";
  }

  try {
    const outreach = missedCallOutreachMessage();
    await sendOutboundWhatsAppText(phone, outreach);
    appendMessage(phone, "assistant", outreach);
    markMissedCallPending(phone, classified.leadOrigin);
    console.log("[email] Llamada perdida: outreach WhatsApp enviado (lead al agente pendiente)", {
      uid: email.uid,
      phone,
      portal: classified.leadOrigin,
    });
    return "sent";
  } catch (e) {
    console.error("[email] Llamada perdida: error enviando WhatsApp", {
      uid: email.uid,
      phone,
      error: e,
    });
    if (isWhatsappNotRegisteredError(e)) return "whatsapp_not_registered";
    return "whatsapp_failed";
  }
}

function missedCallSuppressReason(outcome: MissedCallOutcome): string | null {
  switch (outcome) {
    case "no_phone":
      return "missed_call_no_phone";
    case "invalid_phone":
      return "missed_call_invalid_phone";
    case "whatsapp_not_registered":
      return "missed_call_no_whatsapp";
    case "whatsapp_failed":
      return "missed_call_whatsapp_failed";
    case "proactive_disabled":
      return "missed_call_proactive_disabled";
    default:
      return null;
  }
}

async function handleUnhandledEmail(
  email: FetchedEmail,
  classified: ClassifiedEmail,
): Promise<void> {
  // Importante: `processIncomingText` usa `from` como identidad de conversación y como destino
  // del callback `sendText`. Priorizamos teléfono si existe para no tratar un email como WhatsApp.
  const from = classified.customerPhone
    ?? classified.customerEmail
    ?? `email:${classified.portal ?? "unknown"}:${email.uid}`;

  const isPortalEmail = classified.portal !== null;
  // Regla: portales -> NUNCA responder al "from" (idealista/fotocasa/pisos.com/webphone/etc).
  // Solo respondemos al email real del cliente extraído del cuerpo.
  // Emails directos (portal=null): el "from" sí es el cliente, así que se puede responder ahí.
  const replyToAddressRaw = isPortalEmail
    ? (classified.customerEmail ?? null)
    : (classified.customerEmail ?? email.from ?? null);
  const replyToAddress =
    replyToAddressRaw && !isOwnMailboxAddress(replyToAddressRaw)
      ? replyToAddressRaw
      : null;

  let emailReplyBody = "";
  const replyViaWhatsappOnly =
    isProactiveWhatsAppAllowed() &&
    Boolean(classified.customerPhone) &&
    isLikelyWhatsappNumber(classified.customerPhone!);
  const portalCustomerReply: "whatsapp" | "email" | undefined = replyViaWhatsappOnly
    ? "whatsapp"
    : replyToAddress
      ? "email"
      : undefined;

  await processIncomingText(
    from,
    classified.messageText,
    async (_to, body) => {
      // Solo generamos respuesta. El envío lo gestionamos abajo (WhatsApp/email con fallback).
      emailReplyBody = body;
    },
    async (to, body) => {
      await sendOutboundWhatsAppText(to, body);
    },
    {
      leadChannel: "other",
      customerDisplayId: from,
      customerName: classified.customerName,
      leadOrigin: classified.leadOrigin,
      leadRef: classified.propertyRef,
      portalCustomerReply,
      portalEmailLead: isPortalEmail,
      leadContactPhone: classified.customerPhone,
      leadContactEmail: classified.customerEmail,
    },
  );

  const messageLower = classified.messageText.toLowerCase();
  const ownerMentionsResponsible =
    /\b(propietari[oa]|arrendador|vendedor)\b/i.test(messageLower) &&
    /\b(alvaro|álvaro|miguel|david|jos[eé]|responsable|encargad[oa])\b/i.test(messageLower);
  const ownerCc = ownerMentionsResponsible ? "alvaro@inmobiliariabazan.com" : undefined;
  const emailMainBody =
    ownerMentionsResponsible && emailReplyBody
      ? [
          "Gracias por tu mensaje. Para que lo gestione cuanto antes, te confirmo que pongo en copia a alvaro@inmobiliariabazan.com para que te contacte lo antes posible.",
          "",
          emailReplyBody,
        ].join("\n")
      : emailReplyBody;

  const tryEmail = async (): Promise<boolean> => {
    const emailText = appendCustomerClosing(emailMainBody, true);
    if (!replyToAddress || !emailText) return false;
    const threading = buildReplyThreadingHeaders(email.parsed);
    await sendEmailReply({
      to: replyToAddress,
      cc: ownerCc,
      subject: buildReplySubject(classified.originalSubject),
      text: emailText,
      ...(threading ?? {}),
    });
    console.log("[email] Respuesta enviada por email", {
      to: replyToAddress,
      cc: ownerCc,
      portal: classified.portal,
      uid: email.uid,
    });
    return true;
  };

  // 1) Teléfono válido para WhatsApp → solo WhatsApp (nunca email).
  if (replyViaWhatsappOnly && classified.customerPhone && emailReplyBody) {
    try {
      await sendOutboundWhatsAppText(classified.customerPhone, emailReplyBody.slice(0, 3500));
      console.log("[email] WhatsApp enviado al cliente (sin email)", {
        phone: classified.customerPhone,
        portal: classified.portal,
      });
      markLatestLeadClientDelivery(classified.customerPhone, {
        clientWa: true,
        notes: "Respuesta al cliente por WhatsApp (email portal)",
      });
      return;
    } catch (e) {
      console.error("[email] Error enviando WhatsApp; no se envía email (teléfono válido)", {
        phone: classified.customerPhone,
        portal: classified.portal,
        uid: email.uid,
        error: e,
      });
      markLatestLeadClientDelivery(classified.customerPhone, {
        clientWa: false,
        notes: "Falló WhatsApp de respuesta al cliente (email portal)",
      });
      return;
    }
  }

  // 2) Hay teléfono pero no apto para WhatsApp → email.
  if (classified.customerPhone && emailReplyBody && !replyViaWhatsappOnly) {
    console.warn("[email] Teléfono no apto para WhatsApp; respondiendo por email", {
      phone: classified.customerPhone,
      portal: classified.portal,
      uid: email.uid,
    });
    const emailed = await tryEmail();
    markLatestLeadClientDelivery(classified.customerPhone, {
      clientEmail: emailed,
      notes: emailed
        ? "Respuesta al cliente por email (teléfono no apto para WhatsApp)"
        : "No se pudo responder al cliente por email",
    });
    if (!emailed) {
      console.log("[email] Email no posible (teléfono inválido y sin email cliente)", {
        portal: classified.portal,
        uid: email.uid,
        hasReplyToAddress: Boolean(replyToAddress),
      });
    }
    return;
  }

  // 3) Sin teléfono → email (si se puede).
  const emailed = await tryEmail();
  if (emailed && (classified.customerPhone || classified.customerEmail)) {
    markLatestLeadClientDelivery(classified.customerPhone ?? from, {
      clientEmail: true,
      notes: "Respuesta al cliente por email",
    });
  }
  if (!emailed) {
    console.log("[email] Email no enviado (sin teléfono y sin email del cliente en el cuerpo)", {
      portal: classified.portal,
      uid: email.uid,
      hasReplyToAddress: Boolean(replyToAddress),
      hasBody: Boolean(emailReplyBody),
      isPortalEmail,
    });
  }
}

function persistEmailOutcome(
  email: FetchedEmail,
  classified: ClassifiedEmail,
  handled: boolean,
  suppressReason?: string | null
): void {
  insertEmailState({
    uid: email.uid,
    messageId: email.messageId,
    portal: classified.portal,
    fromAddress: email.from,
    subjectSnippet: email.subject.slice(0, 180),
    bodySnippet: (email.text || "").trim().slice(0, 500),
    suppressReason: suppressReason ?? classified.suppressReason ?? null,
    customerEmail: classified.customerEmail,
    customerPhone: classified.customerPhone,
    handled,
  });
}

async function finalizeEmail(
  email: FetchedEmail,
  classified: ClassifiedEmail,
  handled: boolean,
  suppressReason?: string | null
): Promise<void> {
  persistEmailOutcome(email, classified, handled, suppressReason);
  try {
    await markAsRead([email.uid]);
  } catch (e) {
    console.error("[email] No se pudo marcar como leído (uid registrado en BD; no se reprocesará)", {
      uid: email.uid,
      error: e,
    });
  }
}

async function processOneEmail(email: FetchedEmail): Promise<void> {
  const stored = getEmailStateByUid(email.uid);
  if (stored && isSameStoredEmail(stored, email.messageId)) {
    console.log("[email] UID ya procesado (mismo messageId), marcar leído", { uid: email.uid });
    try {
      await markAsRead([email.uid]);
    } catch (e) {
      console.error("[email] UID procesado pero no se pudo marcar leído", { uid: email.uid, error: e });
    }
    return;
  }
  if (stored && !isSameStoredEmail(stored, email.messageId)) {
    console.log("[email] UID reutilizado (messageId distinto), reprocesar", {
      uid: email.uid,
      prevSubject: stored.subjectSnippet?.slice(0, 80) ?? null,
      newSubject: email.subject.slice(0, 80),
    });
  }

  // Regla: emails de Garantiaya -> NO responder; reenviar a Álvaro en copia/contenido y marcar leído.
  if (isGarantiayaSender(email.from)) {
    const forwardedText = [
      "Email recibido de Garantiaya. No se ha respondido automáticamente.",
      "",
      `From: ${email.from}`,
      `Subject: ${email.subject}`,
      `UID: ${email.uid}`,
      "",
      "---- CONTENIDO ----",
      (email.text || "").trim() || "(sin cuerpo de texto)",
    ].join("\n");
    await sendEmailReply({
      to: "alvaro@inmobiliariabazan.com",
      subject: `Fwd: ${email.subject || "Garantiaya"}`,
      text: forwardedText,
    });
    console.log("[email] Garantiaya reenviado a Álvaro y marcado leído", { uid: email.uid });
    persistEmailOutcome(
      email,
      {
        portal: null,
        customerName: null,
        customerPhone: null,
        customerEmail: null,
        propertyRef: null,
        messageText: "",
        originalSubject: email.subject,
        isAdvertisement: false,
        isMissedCall: false,
        leadOrigin: "email",
        suppressAutoReply: false,
      },
      false
    );
    try {
      await markAsRead([email.uid]);
    } catch (e) {
      console.error("[email] Garantiaya: no se pudo marcar leído", { uid: email.uid, error: e });
    }
    return;
  }

  const classified = classifyEmail(email);
  ingestPortalMappingsFromText(`${email.subject ?? ""}\n${classified.messageText}`);
  if (classified.propertyRef) {
    const ad = extractPortalAdRef(`${email.subject ?? ""}\n${classified.messageText}`);
    if (ad) rememberPortalListing(ad.portal, ad.externalId, classified.propertyRef);
  }

  console.log("[email] Clasificado", {
    uid: email.uid,
    portal: classified.portal,
    from: email.from.slice(0, 60),
    subject: email.subject.slice(0, 80),
    customerPhone: classified.customerPhone,
    customerEmail: classified.customerEmail,
    ref: classified.propertyRef,
    isMissedCall: classified.isMissedCall,
    leadOrigin: classified.leadOrigin,
    isAdvertisement: classified.isAdvertisement,
    suppressAutoReply: classified.suppressAutoReply,
    suppressReason: classified.suppressReason ?? null,
  });

  if (classified.suppressAutoReply) {
    console.log("[email] Spam/phishing (heurística): sin respuesta automática", {
      uid: email.uid,
      subject: email.subject.slice(0, 100),
    });
    await finalizeEmail(email, classified, false);
    return;
  }

  if (classified.isAdvertisement) {
    console.log("[email] Publicidad detectada: marcar como leído y skip", {
      uid: email.uid,
      portal: classified.portal,
    });
    await finalizeEmail(email, classified, false, "advertisement");
    return;
  }

  if (!classified.isMissedCall) {
    const handled = isAlreadyHandled({
      customerPhone: classified.customerPhone,
      customerEmail: classified.customerEmail,
      propertyRef: classified.propertyRef,
    });

    if (handled) {
      console.log("[email] Lead ya gestionado, marcar como leído", {
        uid: email.uid,
        portal: classified.portal,
      });
      await finalizeEmail(email, classified, true);
      return;
    }
  }

  if (classified.isMissedCall) {
    const outcome = await handleMissedCallEmail(email, classified);
    const handled = outcome === "sent" || outcome === "already_pending";
    await finalizeEmail(email, classified, handled, missedCallSuppressReason(outcome));
    return;
  } else {
    await handleUnhandledEmail(email, classified);
  }
  await finalizeEmail(email, classified, true);
}

export async function runEmailPoll(): Promise<void> {
  if (isBlockedByWorkSchedule()) {
    console.log("[email] Pausado por horario laboral (L-V 10:00-19:30 Europe/Madrid); sin leer ni responder emails");
    return;
  }

  console.log("[email] Iniciando poll de emails...");
  resetPollSendCount();
  let emails: FetchedEmail[];
  try {
    emails = await fetchUnseenEmails(30);
  } catch (e) {
    console.error("[email] Error al conectar IMAP", e);
    return;
  }

  if (emails.length === 0) {
    // Fallback: recuperar emails recientes ya vistos pero no procesados (por ejemplo tras un cambio de reglas).
    try {
      emails = await fetchRecentEmails(30);
    } catch (e) {
      console.error("[email] Error al recuperar emails recientes", e);
      return;
    }
  }

  console.log("[email] Emails no leídos encontrados:", emails.length);

  for (const email of emails) {
    try {
      await processOneEmail(email);
    } catch (e) {
      console.error("[email] Error procesando email", { uid: email.uid, error: e });
    }
  }

  console.log("[email] Poll completado");
}
