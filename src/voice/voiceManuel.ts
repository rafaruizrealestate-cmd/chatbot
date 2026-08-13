import { config } from "../config.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import { processIncomingText, type ProcessIncomingContext } from "../whatsapp/processIncomingText.js";

export function normalizeCallerDigits(from: string | undefined): string {
  return (from ?? "").replace(/\D+/g, "");
}

export function voiceLeadContext(callerE164: string, displayFrom: string): ProcessIncomingContext {
  return {
    leadChannel: "voice",
    customerDisplayId: displayFrom.trim() || `+${callerE164}`,
    leadOrigin: "zadarma",
  };
}

/** Ejecuta un turno de Lara (mismo cerebro que WhatsApp) y devuelve el texto de respuesta. */
export async function runManuelVoiceTurn(
  callerDigits: string,
  speech: string,
  displayFrom?: string,
): Promise<string> {
  if (!config.voiceManuelAlwaysOn && isBlockedByWorkSchedule()) {
    return "Gracias por llamar a Inmobiliaria Bazán. Ahora mismo estamos en horario de oficina. Puedes escribirnos por WhatsApp al nueve cinco uno, ocho siete cero, cero cinco ocho, o volver a llamar fuera del horario laboral.";
  }

  const digits = normalizeCallerDigits(callerDigits);
  if (!digits || digits.length < 8) {
    return "No he podido identificar tu número. Gracias por llamar a Inmobiliaria Bazán.";
  }

  const ctx = voiceLeadContext(digits, displayFrom ?? `+${digits}`);
  let captured = "";
  await processIncomingText(
    digits,
    speech.trim(),
    async (to, body) => {
      if (normalizeCallerDigits(to) === digits) captured = body;
    },
    undefined,
    ctx,
  );

  const reply = captured.trim();
  if (!reply) return "¿En qué más puedo ayudarte?";
  return reply;
}
