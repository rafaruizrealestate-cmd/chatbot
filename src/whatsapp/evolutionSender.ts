import axios, { isAxiosError } from "axios";
import { assertEvolutionConfigured, config } from "../config.js";
import { appendArchiveNoteToSent } from "../email/sentArchive.js";
import { parsePhoneToE164Digits } from "../utils/phone.js";
import { resolveEvolutionSendTarget } from "./phoneLid.js";

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** true si el destino es un JID LID de WhatsApp (p. ej. 2327…@lid). */
export function isEvolutionLidJid(input: string): boolean {
  return /@lid$/i.test(input.trim());
}

/**
 * Destino para sendText de Evolution.
 * Con @lid hay que pasar el JID completo (WhatsApp ya no entrega bien al @s.whatsapp.net).
 */
export function evolutionSendNumber(input: string): string {
  const trimmed = input.trim();
  if (isEvolutionLidJid(trimmed)) return trimmed;
  return normalizeNumber(trimmed);
}

/** Evolution espera E.164 solo dígitos (p. ej. 34646424563, nunca 646424563). */
export function normalizeNumber(input: string): string {
  const raw = input.replace(/\D+/g, "");
  if (!raw) return "";
  return parsePhoneToE164Digits(raw) ?? parsePhoneToE164Digits(`+${raw}`) ?? raw;
}

export function isLikelyWhatsappNumber(input: string): boolean {
  if (isEvolutionLidJid(input)) {
    const digits = input.replace(/@lid$/i, "").replace(/\D+/g, "");
    return digits.length >= 8;
  }
  const n = normalizeNumber(input);
  if (n.length < 8 || n.length > 15) return false;

  // Heurística ES: +34 + 9 dígitos (11 total). Suele ser 6/7 (móvil) o 8/9 (fijo).
  if (n.startsWith("34") && n.length === 11) {
    const third = n[2];
    return third === "6" || third === "7" || third === "8" || third === "9";
  }
  // 9 dígitos móviles ES sin prefijo → ya deberían haberse normalizado a 34…
  if (n.length === 9 && /^[67]/.test(n)) return false;
  return true;
}

const DELIVERED_STATUSES = new Set(["SERVER_ACK", "DELIVERY_ACK", "READ", "PLAYED"]);
const FAIL_STATUSES = new Set(["ERROR", "FAILED"]);

type SendTextResponse = {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
  status?: string;
};

/**
 * Evolution acepta el POST aunque WhatsApp acabe en ERROR (no aparece en el móvil).
 * Esperamos el MessageUpdate y fallamos si el estado es ERROR.
 */
async function waitForSendOutcome(
  inst: string,
  apiKey: string,
  remoteJid: string,
  messageId: string,
): Promise<string> {
  const url = joinUrl(config.evolutionBaseUrl, `/chat/findMessages/${encodeURIComponent(inst)}`);
  let last = "PENDING";
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 1200 : 900);
    try {
      const res = await axios.post(
        url,
        { where: { key: { remoteJid } }, limit: 8 },
        {
          headers: { apikey: apiKey, "Content-Type": "application/json" },
          timeout: 15000,
        },
      );
      const records = (res.data?.messages?.records ?? res.data?.records ?? []) as Array<{
        key?: { id?: string };
        MessageUpdate?: Array<{ status?: string }>;
        status?: string;
      }>;
      const hit = records.find((r) => r.key?.id === messageId);
      if (!hit) continue;
      const updates = hit.MessageUpdate ?? [];
      last = updates[updates.length - 1]?.status ?? hit.status ?? last;
      if (FAIL_STATUSES.has(last) || DELIVERED_STATUSES.has(last)) return last;
    } catch (e) {
      console.warn("[evolution] no se pudo leer estado del mensaje", {
        messageId: messageId.slice(-8),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return last;
}

export async function sendEvolutionText(
  to: string,
  body: string,
  instance?: string,
  apiKey?: string,
): Promise<void> {
  assertEvolutionConfigured();
  const inst = (instance ?? config.evolutionInstance).trim();
  if (!inst) {
    throw new Error(
      "EVOLUTION_INSTANCE no configurada y el webhook no incluyó `instance`. Define EVOLUTION_INSTANCE en .env o revisa la configuración del webhook.",
    );
  }
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (!key) {
    throw new Error("EVOLUTION_API_KEY vacía y el webhook no incluyó apikey.");
  }
  const url = joinUrl(config.evolutionBaseUrl, `/message/sendText/${encodeURIComponent(inst)}`);
  // Sin @lid WhatsApp marca muchos envíos a @s.whatsapp.net como ERROR.
  const target = await resolveEvolutionSendTarget(to, inst, key);
  const number = evolutionSendNumber(target);

  try {
    if (!isLikelyWhatsappNumber(target) && !isLikelyWhatsappNumber(to)) {
      throw new Error(`Número no válido para WhatsApp (precheck): ${number}`);
    }
    const post = await axios.post<SendTextResponse>(
      url,
      { number, text: body.slice(0, 4096) },
      {
        headers: {
          apikey: key,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );
    const messageId = post.data?.key?.id?.trim() ?? "";
    const remoteJid =
      post.data?.key?.remoteJid?.trim() ||
      (isEvolutionLidJid(number) ? number : `${normalizeNumber(number)}@s.whatsapp.net`);

    if (isEvolutionLidJid(number)) {
      console.log("[evolution] sendText vía LID", {
        toTail: normalizeNumber(to).slice(-4) || to.slice(-6),
        lidTail: number.replace(/@lid$/i, "").slice(-6),
      });
    }

    if (messageId) {
      const outcome = await waitForSendOutcome(inst, key, remoteJid, messageId);
      if (FAIL_STATUSES.has(outcome)) {
        console.error("[evolution] sendText rechazado por WhatsApp", {
          toTail: normalizeNumber(to).slice(-4) || to.slice(-8),
          remoteJid: remoteJid.slice(-24),
          status: outcome,
          messageId: messageId.slice(-8),
        });
        throw new Error(`WhatsApp delivery ${outcome}`);
      }
      if (outcome === "PENDING") {
        console.warn("[evolution] sendText sigue PENDING tras espera", {
          toTail: normalizeNumber(to).slice(-4) || to.slice(-8),
          messageId: messageId.slice(-8),
        });
      } else {
        console.log("[evolution] sendText entregado", {
          toTail: normalizeNumber(to).slice(-4) || to.slice(-8),
          status: outcome,
        });
      }
    }

    if (config.emailArchiveWhatsappToSent) {
      const ts = new Date().toISOString();
      const cleanTo = isEvolutionLidJid(number) ? number : normalizeNumber(to);
      await appendArchiveNoteToSent({
        subject: `WhatsApp (Evolution) enviado a ${cleanTo} (${ts})`,
        text: `ARCHIVO INTERNO (no es un email enviado)\nCanal: WhatsApp (Evolution)\nInstancia: ${inst}\nDestino: ${cleanTo}\nFecha: ${ts}\n\n--- Mensaje ---\n${body}\n`,
      }).catch((e) => {
        console.warn("[evolution] No se pudo archivar en Enviados:", e);
      });
    }
  } catch (e) {
    if (isAxiosError(e) && e.response?.data) {
      console.error("[evolution] API error:", JSON.stringify(e.response.data));
    }
    throw e;
  }
}

/** Nota de voz (PTT) vía Evolution: base64 MP3/OGG. */
export async function sendEvolutionAudio(
  to: string,
  audioMp3: Buffer,
  instance?: string,
  apiKey?: string,
): Promise<void> {
  assertEvolutionConfigured();
  const inst = (instance ?? config.evolutionInstance).trim();
  if (!inst) {
    throw new Error("EVOLUTION_INSTANCE no configurada para sendWhatsAppAudio.");
  }
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (!key) {
    throw new Error("EVOLUTION_API_KEY vacía para sendWhatsAppAudio.");
  }
  const target = await resolveEvolutionSendTarget(to, inst, key);
  if (!isLikelyWhatsappNumber(target) && !isLikelyWhatsappNumber(to)) {
    throw new Error(`Número no válido para WhatsApp (precheck): ${evolutionSendNumber(to)}`);
  }
  if (!audioMp3.length) throw new Error("audio vacío");

  const url = joinUrl(
    config.evolutionBaseUrl,
    `/message/sendWhatsAppAudio/${encodeURIComponent(inst)}`,
  );
  const number = evolutionSendNumber(target);
  const b64 = audioMp3.toString("base64");

  const attempts: Array<Record<string, unknown>> = [
    // Evolution v2 suele pedir base64 crudo (sin data:...).
    { number, audio: b64, encoding: true },
    { number, audio: `data:audio/mpeg;base64,${b64}`, encoding: true },
    { number, mediatype: "audio", mimetype: "audio/mpeg", media: b64 },
  ];

  let lastErr: unknown;
  for (const payload of attempts) {
    try {
      await axios.post(url, payload, {
        headers: {
          apikey: key,
          "Content-Type": "application/json",
        },
        timeout: 120000,
        maxBodyLength: 25 * 1024 * 1024,
      });
      return;
    } catch (e) {
      lastErr = e;
      if (isAxiosError(e) && e.response?.data) {
        console.warn(
          "[evolution] sendWhatsAppAudio intento fallido:",
          JSON.stringify(e.response.data).slice(0, 300),
        );
      }
    }
  }
  if (isAxiosError(lastErr) && lastErr.response?.data) {
    console.error("[evolution] sendWhatsAppAudio error:", JSON.stringify(lastErr.response.data));
  }
  throw lastErr instanceof Error ? lastErr : new Error("sendWhatsAppAudio failed");
}

/** Evolution devuelve exists:false cuando el número no tiene cuenta WhatsApp. */
export function isWhatsappNotRegisteredError(e: unknown): boolean {
  if (!isAxiosError(e)) return false;
  const data = e.response?.data as
    | { response?: { message?: Array<{ exists?: boolean }> } }
    | undefined;
  const messages = data?.response?.message;
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => m.exists === false);
}
