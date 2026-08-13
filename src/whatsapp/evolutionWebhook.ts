import type { Request, Response } from "express";
import axios, { isAxiosError } from "axios";
import { config } from "../config.js";
import { processIncomingText } from "./processIncomingText.js";
import { sendEvolutionAudio, sendEvolutionText } from "./evolutionSender.js";
import { getCachedLidForPhone, rememberPhoneLid, resolveLidForPhone } from "./phoneLid.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import { transcribeAudioBuffer } from "../voice/transcribeAudio.js";
import { synthesizeSpeechMp3 } from "../voice/ttsAudio.js";

type EvolutionMessageKey = {
  id?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
  fromMe?: boolean;
  addressingMode?: string;
};

type EvolutionPayload = {
  event?: string;
  instance?: string;
  apikey?: string;
  sender?: string;
  data?: {
    key?: EvolutionMessageKey;
    message?: Record<string, unknown>;
    messages?: Array<{
      key?: EvolutionMessageKey;
      message?: Record<string, unknown>;
    }>;
  };
};

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

function extractText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const conv = message["conversation"];
  if (typeof conv === "string" && conv.trim()) return conv.trim();

  const ext = message["extendedTextMessage"];
  if (ext && typeof ext === "object") {
    const t = (ext as { text?: unknown }).text;
    if (typeof t === "string" && t.trim()) return t.trim();
  }

  const img = message["imageMessage"];
  if (img && typeof img === "object") {
    const cap = (img as { caption?: unknown }).caption;
    if (typeof cap === "string" && cap.trim()) return cap.trim();
  }

  const vid = message["videoMessage"];
  if (vid && typeof vid === "object") {
    const cap = (vid as { caption?: unknown }).caption;
    if (typeof cap === "string" && cap.trim()) return cap.trim();
  }

  return undefined;
}

function extractAudio(
  message: Record<string, unknown> | undefined,
): { url?: string; mimetype?: string; hasAudio: boolean } | undefined {
  if (!message) return undefined;
  const am = message["audioMessage"];
  if (!am || typeof am !== "object") return undefined;
  const o = am as { url?: unknown; mimetype?: unknown };
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined;
  const mimetype = typeof o.mimetype === "string" ? o.mimetype : undefined;
  return { url, mimetype, hasAudio: true };
}

function sniffAudioFilename(buf: Buffer, mimetype?: string): string {
  const mime = (mimetype ?? "").toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3")) return "evo.mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "evo.m4a";
  if (mime.includes("webm")) return "evo.webm";
  if (mime.includes("wav")) return "evo.wav";
  if (mime.includes("ogg") || mime.includes("opus")) return "evo.ogg";

  // Magic bytes (URL directa de Evolution a veces baja .enc / basura).
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "OggS") return "evo.ogg";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "RIFF") return "evo.wav";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "evo.webm";
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "ID3") return "evo.mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return "evo.mp3";
  if (buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return "evo.m4a";

  // WhatsApp PTT suele ser opus en contenedor ogg.
  return "evo.ogg";
}

async function downloadEvolutionMediaUrl(url: string, apiKey?: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (key) headers["apikey"] = key;
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      headers,
      timeout: 120000,
      maxRedirects: 5,
    });
    return Buffer.from(res.data);
  } catch (e) {
    if (isAxiosError(e) && e.response?.data) {
      console.error(
        "[evolution-webhook] descarga audio HTTP",
        e.response.status,
        String(e.response.data).slice(0, 200),
      );
    }
    throw e;
  }
}

/** Descifrado correcto del audio vía Evolution (la URL del webhook suele ser .enc). */
async function downloadEvolutionMediaBase64(
  instance: string,
  messageId: string,
  apiKey?: string,
): Promise<{ buffer: Buffer; mimetype?: string }> {
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (!key) throw new Error("EVOLUTION_API_KEY vacía para getBase64FromMediaMessage");
  const url = joinUrl(
    config.evolutionBaseUrl,
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
  );
  const res = await axios.post(
    url,
    {
      message: { key: { id: messageId } },
      convertToMp4: false,
    },
    {
      headers: { apikey: key, "Content-Type": "application/json" },
      timeout: 120000,
    },
  );
  const data = res.data as { base64?: string; mimetype?: string } | undefined;
  const b64 = typeof data?.base64 === "string" ? data.base64.trim() : "";
  if (!b64) throw new Error("getBase64FromMediaMessage sin base64");
  return {
    buffer: Buffer.from(b64, "base64"),
    mimetype: typeof data?.mimetype === "string" ? data.mimetype : undefined,
  };
}

function isLidJid(jid: string | undefined): boolean {
  return Boolean(jid && /@lid$/i.test(jid.trim()));
}

function isGroupJid(jid: string | undefined): boolean {
  return Boolean(jid && /@g\.us$/i.test(jid.trim()));
}

/** Solo JIDs de teléfono (@s.whatsapp.net o dígitos E.164). Nunca digitos de un @lid. */
function jidToPhone(jid: string): string | undefined {
  const trimmed = jid.trim();
  if (!trimmed || isLidJid(trimmed) || isGroupJid(trimmed)) return undefined;
  const m = trimmed.match(/^(\d+)(?:@s\.whatsapp\.net)?$/i);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * WhatsApp (addressingMode lid) entrega bien al @lid; el @s.whatsapp.net suele quedar ERROR.
 * El webhook a menudo manda el teléfono en remoteJid aunque en BD el mensaje esté en @lid.
 */
function resolvePhoneAndReplyTo(key: EvolutionMessageKey | undefined, fallbackJid?: string): {
  phone?: string;
  replyTo?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
} {
  const remote = (key?.remoteJid ?? fallbackJid ?? "").trim();
  const alt = (key?.remoteJidAlt ?? "").trim();
  const lid = isLidJid(remote) ? remote : isLidJid(alt) ? alt : undefined;
  const phoneJid = isLidJid(remote) ? alt : remote;
  const phone = jidToPhone(phoneJid) ?? (alt ? jidToPhone(alt) : undefined);
  const replyTo = lid ?? phone ?? (remote || undefined);
  return {
    phone,
    replyTo,
    remoteJid: remote || undefined,
    remoteJidAlt: alt || undefined,
  };
}

type EvoMsgRecord = {
  key?: EvolutionMessageKey;
};

/** Lee la key real del mensaje en Evolution (suele traer @lid aunque el webhook mande teléfono). */
async function findMessageKeyById(
  messageId: string,
  instance: string,
  apiKey?: string,
): Promise<EvolutionMessageKey | undefined> {
  const inst = instance.trim();
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (!inst || !key || !messageId) return undefined;
  try {
    const url = joinUrl(config.evolutionBaseUrl, `/chat/findMessages/${encodeURIComponent(inst)}`);
    const res = await axios.post(
      url,
      { where: { key: { id: messageId } }, limit: 1 },
      { headers: { apikey: key, "Content-Type": "application/json" }, timeout: 15000 },
    );
    const records =
      (res.data as { messages?: { records?: EvoMsgRecord[] } })?.messages?.records ??
      (Array.isArray(res.data) ? (res.data as EvoMsgRecord[]) : []);
    const first = records[0];
    return first?.key;
  } catch (e) {
    console.warn("[evolution-webhook] findMessageKeyById falló", e);
    return undefined;
  }
}

/** Localiza @lid: caché persistente → mensaje actual → contactos/historial Evolution. */
async function findLidForPhone(
  phone: string,
  instance: string,
  apiKey?: string,
  messageId?: string,
): Promise<string | undefined> {
  const cached = getCachedLidForPhone(phone);
  if (cached) return cached;

  if (messageId) {
    const msgKey = await findMessageKeyById(messageId, instance, apiKey);
    if (msgKey) {
      const fromMsg = resolvePhoneAndReplyTo(msgKey);
      if (fromMsg.replyTo && isLidJid(fromMsg.replyTo)) {
        rememberPhoneLid(phone, fromMsg.replyTo);
        return fromMsg.replyTo;
      }
      if (isLidJid(msgKey.remoteJid)) {
        rememberPhoneLid(phone, msgKey.remoteJid);
        return msgKey.remoteJid!.trim();
      }
    }
  }

  return resolveLidForPhone(phone, instance, apiKey);
}

function apiKeyFromReq(req: Request): string {
  const headerValue = req.header("apikey");
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  const bodyValue = (req.body as EvolutionPayload | undefined)?.apikey;
  if (typeof bodyValue === "string" && bodyValue.trim()) {
    return bodyValue.trim();
  }
  return "";
}

function normalizeEvent(raw: string | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[.\-]/g, "_");
}

function eventFromPath(path: string): string | undefined {
  if (!path.startsWith("/webhook/")) return undefined;
  const suffix = path.slice("/webhook/".length).trim();
  return suffix.length > 0 ? suffix : undefined;
}

function firstIncomingNode(body: EvolutionPayload): {
  fromMe?: boolean;
  key?: EvolutionMessageKey;
  jid?: string;
  messageId?: string;
  message?: Record<string, unknown>;
} {
  const first = Array.isArray(body.data?.messages) ? body.data?.messages[0] : undefined;
  const key = first?.key ?? body.data?.key;
  return {
    fromMe: key?.fromMe,
    key,
    jid: key?.remoteJid ?? body.sender,
    messageId: key?.id,
    message: first?.message ?? body.data?.message,
  };
}

export async function handleEvolutionWebhookPost(req: Request, res: Response): Promise<void> {
  res.sendStatus(200);

  const body = req.body as EvolutionPayload;
  const routeEvent = typeof req.params?.event === "string" ? req.params.event : undefined;
  const rawEvent = body?.event ?? routeEvent ?? eventFromPath(req.path) ?? "";
  const event = normalizeEvent(rawEvent);

  console.log("[evolution-webhook] POST recibido", {
    path: req.path,
    event: rawEvent,
    normalized: event,
    instance: body?.instance,
    sender: body?.sender,
    remoteJid: body?.data?.key?.remoteJid,
    remoteJidAlt: body?.data?.key?.remoteJidAlt,
    addressingMode: body?.data?.key?.addressingMode,
    fromMe: body?.data?.key?.fromMe,
    hasMessage: !!body?.data?.message,
    hasMessages: Array.isArray(body?.data?.messages),
    bodyKeys: body ? Object.keys(body) : [],
  });

  const key = apiKeyFromReq(req);
  const replyApiKey = key || config.evolutionApiKey.trim() || undefined;
  if (replyApiKey && config.evolutionApiKey && replyApiKey !== config.evolutionApiKey) {
    console.log("[evolution-webhook] apikey de instancia distinta a EVOLUTION_API_KEY global (ok multi-instancia)");
  }

  if (event !== "MESSAGES_UPSERT") {
    console.log("[evolution-webhook] evento ignorado:", rawEvent);
    return;
  }

  const instance = typeof body?.instance === "string" ? body.instance : undefined;
  const incoming = firstIncomingNode(body);

  if (incoming.fromMe) {
    console.log("[evolution-webhook] ignorando mensaje propio (fromMe)");
    return;
  }

  if (!incoming.jid && !incoming.key?.remoteJidAlt) {
    console.warn("[evolution-webhook] sin JID (sender/remoteJid vacío)");
    return;
  }

  let keyForResolve = incoming.key;
  // El webhook a menudo reescribe remoteJid a teléfono; la key real en Evolution trae @lid.
  if (instance && incoming.messageId && !isLidJid(incoming.key?.remoteJid) && !isLidJid(incoming.key?.remoteJidAlt)) {
    const realKey = await findMessageKeyById(incoming.messageId, instance, replyApiKey);
    if (realKey && (isLidJid(realKey.remoteJid) || isLidJid(realKey.remoteJidAlt))) {
      keyForResolve = { ...incoming.key, ...realKey };
      console.log("[evolution-webhook] key enriquecida desde findMessages", {
        remoteJid: realKey.remoteJid,
        remoteJidAlt: realKey.remoteJidAlt,
      });
    }
  }

  const resolved = resolvePhoneAndReplyTo(keyForResolve, incoming.jid);
  let from = resolved.phone;
  let replyTo = resolved.replyTo;

  if (!from) {
    console.warn("[evolution-webhook] JID sin teléfono usable", {
      remoteJid: resolved.remoteJid,
      remoteJidAlt: resolved.remoteJidAlt,
    });
    return;
  }

  rememberPhoneLid(from, isLidJid(replyTo) ? replyTo : undefined);

  // Si solo tenemos teléfono, buscar @lid (caché / mensaje / contactos).
  if (replyTo && !isLidJid(replyTo) && instance) {
    const lid = await findLidForPhone(from, instance, replyApiKey, incoming.messageId);
    if (lid) {
      console.log("[evolution-webhook] reply vía LID resuelto", {
        fromTail: from.slice(-4),
        lidTail: lid.replace(/@lid$/i, "").slice(-6),
      });
      replyTo = lid;
    } else {
      console.warn("[evolution-webhook] sin LID; el envío al teléfono puede fallar (ERROR)", {
        fromTail: from.slice(-4),
      });
    }
  }

  const text = extractText(incoming.message);
  const audio = extractAudio(incoming.message);
  if (!text?.trim() && !audio?.hasAudio) {
    console.log("[evolution-webhook] mensaje sin texto ni audio usable");
    return;
  }

  console.log("[evolution-webhook] Mensaje entrante", {
    from,
    replyTo,
    remoteJid: resolved.remoteJid,
    remoteJidAlt: resolved.remoteJidAlt,
    instance,
    preview: text?.trim() ? text.slice(0, 80) : "(audio)",
    messageId: incoming.messageId ?? null,
  });
  const blocked = isBlockedByWorkSchedule();
  console.log("[evolution-webhook] workSchedule", { blocked, fromTail: from.slice(-4), instance: instance ?? null });
  if (blocked) {
    console.log("[evolution-webhook] Ignorado: horario bloqueado L-V 10:00–19:30 Europe/Madrid (sin encolar)", {
      from,
      instance,
    });
    return;
  }

  let userMessage = text?.trim() ?? "";
  if (!userMessage && audio?.hasAudio) {
    try {
      let buf: Buffer | null = null;
      let mime = audio.mimetype;

      const inst = (instance ?? config.evolutionInstance).trim();
      if (inst && incoming.messageId) {
        try {
          const decoded = await downloadEvolutionMediaBase64(inst, incoming.messageId, replyApiKey);
          buf = decoded.buffer;
          mime = decoded.mimetype ?? mime;
          console.log("[evolution-webhook] audio via getBase64FromMediaMessage", {
            bytes: buf.length,
            mimetype: mime ?? null,
          });
        } catch (e) {
          console.warn("[evolution-webhook] getBase64FromMediaMessage falló; intento URL", e);
        }
      }

      if (!buf && audio.url) {
        buf = await downloadEvolutionMediaUrl(audio.url, replyApiKey);
        console.log("[evolution-webhook] audio via URL directa", { bytes: buf.length });
      }
      if (!buf?.length) throw new Error("audio vacío tras descarga");

      const filename = sniffAudioFilename(buf, mime);
      console.log("[evolution-webhook] transcribiendo", { filename, bytes: buf.length });
      userMessage = (await transcribeAudioBuffer(buf, filename, "es")).trim();
      console.log("[evolution-webhook] transcripción", { preview: userMessage.slice(0, 120) });
    } catch (e) {
      console.error("[evolution-webhook] Error transcribiendo audio", e);
      try {
        await sendEvolutionText(
          replyTo ?? from,
          "No he podido escuchar bien tu nota de voz. ¿Puedes escribirme el mensaje o mandar el audio otra vez?",
          instance,
          replyApiKey,
        );
      } catch (sendErr) {
        console.error("[evolution-webhook] No se pudo avisar fallo de audio", sendErr);
      }
      return;
    }
  }
  if (!userMessage) {
    console.log("[evolution-webhook] transcripción vacía");
    return;
  }

  const sendDest = replyTo ?? from;

  void processIncomingText(
    from,
    userMessage,
    async (_to, bodyText) => {
      const replyWithVoice = Boolean(audio?.hasAudio) && config.whatsappVoiceReply;
      if (replyWithVoice) {
        try {
          // Si el cliente manda nota de voz, respondemos solo con audio (texto solo si falla TTS/envío).
          const mp3 = await synthesizeSpeechMp3(bodyText);
          await sendEvolutionAudio(sendDest, mp3, instance, replyApiKey);
          console.log("[evolution-webhook] respuesta solo audio enviada", {
            to: sendDest,
            audioBytes: mp3.length,
          });
          return;
        } catch (e) {
          console.error("[evolution-webhook] fallo respuesta en audio; solo texto", e);
        }
      }
      await sendEvolutionText(sendDest, bodyText, instance, replyApiKey);
    },
  ).catch((err) => {
    console.error("[evolution-webhook] processIncomingText", err);
  });
}
