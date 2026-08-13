import { config } from "../config.js";
import { sendWhatsAppText } from "./sender.js";
import { sendEvolutionText } from "./evolutionSender.js";

export { isLikelyWhatsappNumber } from "./evolutionSender.js";

/** True si está permitido iniciar WhatsApp a quien aún no ha escrito. */
export function isProactiveWhatsAppAllowed(): boolean {
  return config.whatsappProactiveOutreach;
}

/** Envío saliente al cliente o agente según WHATSAPP_PROVIDER (evolution | meta). */
export async function sendOutboundWhatsAppText(
  to: string,
  body: string,
  instance?: string
): Promise<void> {
  const provider = config.whatsappProvider;
  if (provider === "evolution") {
    await sendEvolutionText(to, body, instance);
    return;
  }
  if (provider === "meta") {
    await sendWhatsAppText(to, body);
    return;
  }
  throw new Error(`WHATSAPP_PROVIDER no soportado: ${provider}`);
}
