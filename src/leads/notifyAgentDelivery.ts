import type { AgentContact } from "../agents/assignment.js";
import { config } from "../config.js";
import { appendMessage } from "../db/conversations.js";
import { sendEmailReply } from "../email/smtpSender.js";
import { resolveAgentEmailForVoice } from "../voice/voiceLeadEmail.js";
import { sendOutboundWhatsAppText } from "../whatsapp/outbound.js";

export type AgentNotifyResult = {
  whatsapp: boolean;
  email: boolean;
  /** Email del comercial si se intentó / resolvió. */
  agentEmailAddress?: string | null;
};

/**
 * Avisa al comercial del lead.
 * WhatsApp suele fallar en entrega si no hay @lid; el email es la red de seguridad:
 * si el canal es solo WhatsApp y el envío falla, se intenta email igualmente.
 * Los envíos WA se registran en conversations para verlos en el panel.
 */
export async function deliverAgentLeadNotification(
  agent: AgentContact,
  note: string,
  opts?: { ref?: string | null },
): Promise<AgentNotifyResult> {
  const channel = config.agentNotifyChannel;
  const ref = opts?.ref?.trim();
  const subject = ref
    ? `[${config.botName}] Nuevo lead — ref. ${ref}`
    : `[${config.botName}] Nuevo lead`;
  const result: AgentNotifyResult = { whatsapp: false, email: false, agentEmailAddress: null };
  const agentPhone = agent.phone.replace(/\D+/g, "");

  if (channel === "whatsapp" || channel === "both") {
    try {
      await sendOutboundWhatsAppText(agent.phone, note, config.evolutionInstance || undefined);
      result.whatsapp = true;
      if (agentPhone.length >= 8) {
        appendMessage(agentPhone, "assistant", note);
      }
      console.log("[lead] Aviso enviado al comercial por WhatsApp", {
        agent: agent.name,
        phone: agent.phone,
        ref: ref ?? null,
      });
    } catch (e) {
      result.whatsapp = false;
      console.warn("[lead] No se pudo notificar al agente por WhatsApp (entrega real fallida)", {
        agent: agent.name,
        phone: agent.phone,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const wantEmail =
    channel === "email" || channel === "both" || (channel === "whatsapp" && !result.whatsapp);

  if (wantEmail) {
    const email = resolveAgentEmailForVoice(agent);
    result.agentEmailAddress = email;
    if (!email) {
      console.error("[lead] Sin email para comercial", { agent: agent.name, phone: agent.phone });
      return result;
    }
    if (!config.smtpConfigured) {
      console.error("[lead] SMTP no configurado; no se puede notificar al comercial por email");
      return result;
    }
    try {
      await sendEmailReply({
        to: email,
        subject,
        text: note,
        skipGuards: true,
      });
      result.email = true;
      console.log("[lead] Aviso enviado al comercial por email", {
        agent: agent.name,
        email,
        ref,
        fallbackFromWhatsapp: channel === "whatsapp" && !result.whatsapp,
      });
    } catch (e) {
      console.error("[lead] Fallo notificación email al comercial", {
        agent: agent.name,
        email,
        error: e,
      });
    }
  }

  return result;
}
