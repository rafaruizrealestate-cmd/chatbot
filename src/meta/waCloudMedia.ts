import axios, { isAxiosError } from "axios";
import { config } from "../config.js";

const API_VERSION = "v25.0";

/** Descarga el binario de un audio/imagen de WhatsApp Cloud API. */
export async function downloadWhatsAppCloudMediaBuffer(mediaId: string): Promise<Buffer> {
  const token = config.whatsappToken.trim();
  if (!token) throw new Error("WHATSAPP_TOKEN vacío");
  const metaUrl = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(mediaId)}`;
  const metaRes = await axios.get<{ url?: string }>(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  const downloadUrl = metaRes.data?.url;
  if (!downloadUrl) throw new Error("Graph API: media sin URL de descarga");
  const bin = await axios.get<ArrayBuffer>(downloadUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${token}` },
    timeout: 120000,
  });
  return Buffer.from(bin.data);
}

export function logWaMediaError(e: unknown, mediaId: string): void {
  if (isAxiosError(e) && e.response?.data) {
    console.error("[wa-media] Graph error", mediaId, JSON.stringify(e.response.data));
  } else {
    console.error("[wa-media] Error descargando media", mediaId, e);
  }
}
