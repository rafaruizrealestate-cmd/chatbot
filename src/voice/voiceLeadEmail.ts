import type { AgentContact } from "../agents/assignment.js";
import { config } from "../config.js";
import { sendEmailReply } from "../email/smtpSender.js";
import { hasRecentOutboundTo } from "../email/emailGuards.js";
import { formatAgentPhoneEs, formatLeadForAgent } from "../leads/agentNotification.js";
import { searchProperties, type PropertyRow } from "../knowledge/properties.js";
import { isGarbageCustomerEmail, isGarbageClientName } from "../utils/portalLeadText.js";
import {
  formatCustomerPropertyMessage,
  formatLeadOriginForCustomer,
} from "../whatsapp/customerPropertyMessage.js";
import { isLikelyWhatsappNumber, sendOutboundWhatsAppText } from "../whatsapp/outbound.js";
import { parsePhoneToE164Digits } from "../utils/phone.js";
import type { VoiceIntent } from "./realtimeTools.js";
import {
  getVoiceCall,
  getVoiceCallTurns,
  type VoiceCallRow,
  type VoiceCallTurnRow,
} from "./voiceCallStore.js";

/** Teléfono cliente para WhatsApp/leads: siempre E.164 (añade 34 si el LLM pasa 9 dígitos). */
export function resolveVoiceClientPhone(
  phone: string | null | undefined,
  caller: string | null | undefined
): string {
  const fromPhone = phone?.trim()
    ? parsePhoneToE164Digits(phone) ?? parsePhoneToE164Digits(phone.replace(/\D+/g, ""))
    : null;
  const fromCaller = caller?.trim()
    ? parsePhoneToE164Digits(caller) ?? parsePhoneToE164Digits(caller.replace(/\D+/g, ""))
    : null;
  return fromPhone || fromCaller || "";
}

export type VoiceLeadEmailInput = {
  caller: string;
  intent: VoiceIntent;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  ref?: string | null;
  summary?: string | null;
  agent: AgentContact;
  property?: PropertyRow | null;
  /** Si el aviso al comercial ya se envió por otro canal. */
  skipAgentEmail?: boolean;
};

function normalizePhoneDigits(phone: string): string {
  return resolveVoiceClientPhone(phone, null) || phone.replace(/\D+/g, "");
}

/** Email del comercial según teléfono (mapa .env, buyer/owner por defecto, fallback owner). */
export function resolveAgentEmailForVoice(agent: AgentContact): string | null {
  const digits = normalizePhoneDigits(agent.phone);
  const adminDigits = normalizePhoneDigits(config.voiceAdminPhone);
  if (adminDigits && digits === adminDigits && config.voiceAdminEmail) {
    return config.voiceAdminEmail;
  }
  const adminNames = new Set(
    ["administrativo", config.voiceAdminName.toLowerCase()].filter(Boolean),
  );
  if (adminNames.has(agent.name.trim().toLowerCase()) && config.voiceAdminEmail) {
    return config.voiceAdminEmail;
  }

  const fromMap = config.voiceAgentEmailByPhone.get(digits);
  if (fromMap) return fromMap;

  const buyerDigits = normalizePhoneDigits(config.voiceBuyerAgentPhone);
  const ownerDigits = normalizePhoneDigits(config.voiceOwnerAgentPhone);
  if (digits === buyerDigits && config.voiceBuyerAgentEmail) return config.voiceBuyerAgentEmail;
  if (digits === ownerDigits && config.voiceOwnerAgentEmail) return config.voiceOwnerAgentEmail;

  return config.voiceOwnerAgentEmail || config.voiceBuyerAgentEmail || null;
}

function isValidClientEmail(email: string | null | undefined): email is string {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  return !isGarbageCustomerEmail(e);
}

export function formatVoiceCallClientConfirmation(input: {
  name?: string | null;
  agent: AgentContact;
  ref?: string | null;
  summary?: string | null;
}): string {
  const name = input.name?.trim();
  const greeting = name && !isGarbageClientName(name) ? `Hola ${name},` : "Hola,";
  const origin = formatLeadOriginForCustomer("llamada");
  const summary = (input.summary ?? "").trim();

  const lines = [
    greeting,
    "",
    `Gracias por contactar con Inmobiliaria Bazán tras ${origin}.`,
    "Hemos registrado tu consulta y un asesor se pondrá en contacto contigo lo antes posible.",
  ];

  if (input.ref?.trim()) {
    const ref = input.ref.trim();
    const propertyUrl = `https://www.inmobiliariabazan.com/propiedad?propiedad=${encodeURIComponent(ref)}`;
    lines.push("", `Referencia de interés: ${ref}.`, propertyUrl);
  }
  if (summary) {
    lines.push("", `Resumen: ${summary}`);
  }

  const agentName = input.agent.name?.trim();
  const agentPhone = input.agent.phone?.trim();
  if (agentName && agentPhone) {
    lines.push(
      "",
      `Tu comercial es ${agentName}, Telf: ${formatAgentPhoneEs(agentPhone)}. Por favor contáctale por su WhatsApp o, si prefieres, llámalo, para coordinar una visita.`,
    );
  }

  lines.push(
    "",
    "Si no deseas que te contactemos por email, responde a este mensaje indicándolo.",
  );

  return lines.join("\n");
}

export type VoiceLeadEmailResult = {
  agentEmailSent: boolean;
  clientEmailSent: boolean;
  agentEmail?: string | null;
  clientEmail?: string | null;
  errors: string[];
};

/** Aviso al comercial y confirmación al cliente (mismo contenido que el lead por WhatsApp). */
export async function sendVoiceLeadEmails(input: VoiceLeadEmailInput): Promise<VoiceLeadEmailResult> {
  const result: VoiceLeadEmailResult = {
    agentEmailSent: false,
    clientEmailSent: false,
    errors: [],
  };

  if (!config.voiceLeadEmailEnabled || !config.smtpConfigured) {
    return result;
  }

  const clientPhone = normalizePhoneDigits(input.phone ?? "") || normalizePhoneDigits(input.caller);
  const ref = input.ref?.trim() || null;
  const property =
    input.property ??
    (ref ? searchProperties({ ref, limit: 1 })[0] : undefined);
  const propertyUrl =
    property?.url?.trim() ||
    (ref ? `https://www.inmobiliariabazan.com/propiedad?propiedad=${encodeURIComponent(ref)}` : null);
  const summary =
    (input.summary ?? "").trim() || `Llamada de voz. Intención: ${input.intent}.`;

  const agentEmail = resolveAgentEmailForVoice(input.agent);
  result.agentEmail = agentEmail;

  if (agentEmail && !input.skipAgentEmail) {
    const agentBody = formatLeadForAgent({
      origin: "llamada",
      name: input.name ?? null,
      phone: clientPhone,
      email: input.email ?? null,
      ref,
      propertyUrl,
      clientInfo: summary,
    });
    const refLabel = ref ? ` ref ${ref}` : "";
    try {
      await sendEmailReply({
        to: agentEmail,
        subject: `Nuevo lead por llamada${refLabel} — Inmobiliaria Bazán`,
        text: agentBody,
      });
      result.agentEmailSent = true;
      console.log("[voice/email] Aviso al comercial enviado", {
        to: agentEmail,
        agent: input.agent.name,
        ref,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`agent_email: ${msg}`);
      console.error("[voice/email] No se pudo enviar email al comercial", {
        to: agentEmail,
        error: e,
      });
    }
  } else {
    result.errors.push("agent_email: no_address");
  }

  const clientEmail = isValidClientEmail(input.email) ? input.email.trim() : null;
  result.clientEmail = clientEmail;

  if (clientEmail) {
    // Evita confirmación duplicada si el LLM vuelve a derivar en la misma llamada.
    if (hasRecentOutboundTo(clientEmail, 60)) {
      console.log("[voice/email] Confirmación al cliente omitida (ya enviada hace <60 min)", {
        to: clientEmail,
        ref,
      });
    } else {
      let clientBody: string;
      if (property) {
        clientBody = formatCustomerPropertyMessage({
          property,
          agent: input.agent,
          customerName: input.name ?? null,
          leadOrigin: "llamada",
          withClosing: true,
          agentLineStyle: "visit",
        });
      } else {
        clientBody = formatVoiceCallClientConfirmation({
          name: input.name,
          agent: input.agent,
          ref,
          summary,
        });
      }

      const subject = property
        ? `Tu consulta sobre ${property.title} (ref. ${property.ref}) — Inmobiliaria Bazán`
        : "Confirmación de tu llamada — Inmobiliaria Bazán";

      try {
        await sendEmailReply({
          to: clientEmail,
          subject,
          text: clientBody,
        });
        result.clientEmailSent = true;
        console.log("[voice/email] Confirmación al cliente enviada", {
          to: clientEmail,
          ref,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`client_email: ${msg}`);
        console.error("[voice/email] No se pudo enviar email al cliente", {
          to: clientEmail,
          error: e,
        });
      }
    }
  }

  return result;
}

/** Cuerpo de confirmación al cliente (misma lógica email / WhatsApp). */
export function buildVoiceClientConfirmationBody(input: {
  name?: string | null;
  agent: AgentContact;
  ref?: string | null;
  summary?: string | null;
  property?: PropertyRow | null;
  leadOrigin?: string | null;
}): string {
  const ref = input.ref?.trim() || null;
  const property =
    input.property ?? (ref ? searchProperties({ ref, limit: 1 })[0] : undefined);
  const origin = (input.leadOrigin ?? "llamada").trim() || "llamada";
  if (property) {
    return formatCustomerPropertyMessage({
      property,
      agent: input.agent,
      customerName: input.name ?? null,
      leadOrigin: origin,
      withClosing: true,
      agentLineStyle: "visit",
    });
  }
  return formatVoiceCallClientConfirmation({
    name: input.name,
    agent: input.agent,
    ref,
    summary: input.summary,
  });
}

/**
 * WhatsApp al móvil del cliente tras handoff (contacto del comercial / ficha).
 * Independiente de WHATSAPP_PROACTIVE_OUTREACH.
 * En llamadas respeta VOICE_CLIENT_WHATSAPP_CONFIRM; en handoff WA/email usar forHandoff.
 */
export async function sendVoiceClientWhatsAppConfirm(input: {
  phone: string;
  name?: string | null;
  agent: AgentContact;
  ref?: string | null;
  summary?: string | null;
  property?: PropertyRow | null;
  /** true = handoff WhatsApp/email/portal; no exige el flag de voz */
  forHandoff?: boolean;
  /** Origen para el texto de la ficha (por defecto llamada). */
  leadOrigin?: string | null;
}): Promise<boolean> {
  if (!input.forHandoff && !config.voiceClientWhatsappConfirm) return false;
  const to = resolveVoiceClientPhone(input.phone, null);
  if (!to || !isLikelyWhatsappNumber(to)) {
    console.warn("[voice/whatsapp] Skip confirmación: teléfono no E.164 válido", {
      raw: input.phone,
      to,
    });
    return false;
  }

  const own = normalizePhoneDigits(process.env.WHATSAPP_OWN_NUMBER ?? "");
  if (own && to === own) {
    console.log("[voice/whatsapp] Skip confirmación: número propio del bot", { to });
    return false;
  }

  const body = buildVoiceClientConfirmationBody({
    ...input,
    leadOrigin: input.leadOrigin ?? (input.forHandoff ? "whatsapp" : "llamada"),
  });
  try {
    await sendOutboundWhatsAppText(to, body, config.evolutionInstance || undefined);
    console.log("[voice/whatsapp] Confirmación al cliente enviada", {
      to,
      ref: input.ref ?? null,
      agent: input.agent.name,
      forHandoff: Boolean(input.forHandoff),
    });
    return true;
  } catch (e) {
    console.error("[voice/whatsapp] No se pudo enviar confirmación al cliente", {
      to,
      error: e,
    });
    return false;
  }
}

export type EnviarEmailClienteInput = {
  email: string;
  name?: string | null;
  ref?: string | null;
  text?: string | null;
  agent: AgentContact;
};

export async function sendVoiceClientPropertyEmail(
  input: EnviarEmailClienteInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.voiceLeadEmailEnabled || !config.smtpConfigured) {
    return { ok: false, error: "email_disabled" };
  }

  const to = input.email.trim();
  if (!isValidClientEmail(to)) return { ok: false, error: "invalid_email" };

  const ref = input.ref?.trim() || null;
  let body = (input.text ?? "").trim();

  if (!body && ref) {
    const property = searchProperties({ ref, limit: 1 })[0];
    if (property) {
      body = formatCustomerPropertyMessage({
        property,
        agent: input.agent,
        customerName: input.name ?? null,
        leadOrigin: "llamada",
        withClosing: true,
        agentLineStyle: "visit",
      });
    }
  }

  if (!body) return { ok: false, error: "nothing_to_send" };

  const subject = ref
    ? `Ficha inmueble ref. ${ref} — Inmobiliaria Bazán`
    : "Información solicitada — Inmobiliaria Bazán";

  try {
    await sendEmailReply({ to, subject, text: body });
    return { ok: true };
  } catch (e) {
    console.error("[voice/email] No se pudo enviar ficha por email al cliente", { to, error: e });
    return { ok: false, error: "send_failed" };
  }
}

function roleLabel(role: VoiceCallTurnRow["role"]): string {
  if (role === "user") return "Cliente";
  if (role === "assistant") return config.botName || "Lara";
  return "Sistema";
}

function formatCallerDisplay(caller: string): string {
  const digits = caller.replace(/\D+/g, "");
  if (digits.startsWith("34") && digits.length === 11) {
    const local = digits.slice(2);
    return `+34 ${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7)}`;
  }
  if (digits.length === 9) {
    return `+34 ${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}`;
  }
  return digits ? `+${digits}` : "desconocido";
}

/** Cuerpo del email con la transcripción completa de una llamada. */
export function formatVoiceCallTranscriptEmail(input: {
  call: VoiceCallRow;
  turns: VoiceCallTurnRow[];
}): { subject: string; text: string } {
  const { call, turns } = input;
  const caller = formatCallerDisplay(call.caller);
  const subject = `Transcripción llamada ${caller} — ${config.botName || "Lara"}`;

  const meta = [
    `Llamada ID: ${call.id}`,
    `Origen: ${caller}`,
    call.called_did ? `DID: ${call.called_did}` : null,
    `Inicio: ${call.started_at}`,
    call.ended_at ? `Fin: ${call.ended_at}` : null,
    call.intent ? `Intención: ${call.intent}` : null,
    call.disposition ? `Disposición: ${call.disposition}` : null,
    call.language ? `Idioma: ${call.language}` : null,
  ].filter(Boolean) as string[];

  const lines: string[] = [
    `Transcripción completa — Inmobiliaria Bazán (${config.botName || "Lara"})`,
    "",
    ...meta,
  ];

  if (call.summary?.trim()) {
    lines.push("", `Resumen: ${call.summary.trim()}`);
  }

  lines.push("", "——— Conversación ———", "");

  if (turns.length === 0) {
    lines.push("(Sin turnos registrados.)");
  } else {
    for (const turn of turns) {
      lines.push(`[${turn.ts}] ${roleLabel(turn.role)}:`, turn.text, "");
    }
  }

  return { subject, text: lines.join("\n").trimEnd() + "\n" };
}

/** Envía la transcripción de la llamada al correo de ops (Álvaro por defecto). */
export async function sendVoiceCallTranscriptEmail(callId: string): Promise<boolean> {
  if (!config.voiceTranscriptEmailEnabled || !config.smtpConfigured) {
    return false;
  }
  const to = config.voiceTranscriptEmail;
  if (!to) return false;

  const call = getVoiceCall(callId);
  if (!call) return false;

  const turns = getVoiceCallTurns(callId);
  const { subject, text } = formatVoiceCallTranscriptEmail({ call, turns });

  try {
    // Ops interno: no aplicar rate-limit de leads (puede haber varias llamadas/hora).
    await sendEmailReply({ to, subject, text, skipGuards: true, includeHeaderImage: false });
    console.log("[voice/email] Transcripción enviada", {
      to,
      callId,
      turns: turns.length,
    });
    return true;
  } catch (e) {
    console.error("[voice/email] No se pudo enviar transcripción", {
      to,
      callId,
      error: e,
    });
    return false;
  }
}
