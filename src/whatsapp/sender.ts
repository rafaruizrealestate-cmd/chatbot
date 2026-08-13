import { config, assertWhatsAppSendConfigured } from "../config.js";
import axios, { isAxiosError } from "axios";
import { appendArchiveNoteToSent } from "../email/sentArchive.js";

/** Misma familia de versión que el panel de Meta (curl suele mostrar v25.0). */
const API_VERSION = "v25.0";

export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  assertWhatsAppSendConfigured();
  const url = `https://graph.facebook.com/${API_VERSION}/${config.whatsappPhoneId}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: body.slice(0, 4096) },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsappToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    if (config.emailArchiveWhatsappToSent) {
      const ts = new Date().toISOString();
      const cleanTo = to.replace(/\D+/g, "");
      await appendArchiveNoteToSent({
        subject: `WhatsApp enviado a +${cleanTo} (${ts})`,
        text: `ARCHIVO INTERNO (no es un email enviado)\nCanal: WhatsApp Cloud\nDestino: +${cleanTo}\nFecha: ${ts}\n\n--- Mensaje ---\n${body}\n`,
      }).catch((e) => {
        console.warn("[whatsapp] No se pudo archivar en Enviados:", e);
      });
    }
  } catch (e) {
    if (isAxiosError(e) && e.response?.data) {
      console.error("[whatsapp] Graph API error:", JSON.stringify(e.response.data));
    }
    throw e;
  }
}
