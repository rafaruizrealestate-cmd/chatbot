import type { NormalizedMetaInbound } from "./types.js";

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
}

function numStr(x: unknown): string | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return str(x);
}

/** WhatsApp Cloud API (object whatsapp_business_account). */
function parseWhatsAppCloud(body: Record<string, unknown>): NormalizedMetaInbound[] {
  const entry = body["entry"];
  if (!Array.isArray(entry)) return [];
  const out: NormalizedMetaInbound[] = [];
  for (const e of entry) {
    if (!e || typeof e !== "object") continue;
    const changes = (e as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") continue;
      const value = (ch as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const msgs = (value as { messages?: unknown }).messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (!m || typeof m !== "object") continue;
        const mo = m as Record<string, unknown>;
        const from = str(mo["from"]);
        if (!from) continue;
        const waMsgId = str(mo["id"]);
        const msgType = str(mo["type"]);

        if (msgType === "text") {
          const textBody = (mo["text"] as { body?: unknown } | undefined)?.body;
          const text = typeof textBody === "string" ? textBody.trim() : "";
          if (!text) continue;
          const dedupKey = waMsgId ? `wa:${waMsgId}` : `wa:${from}:${text.slice(0, 40)}`;
          out.push({
            channel: "whatsapp_cloud",
            dedupKey,
            conversationKey: from,
            text,
            customerDisplayId: from,
            sendTarget: { kind: "whatsapp_cloud", waId: from },
          });
          continue;
        }

        if (msgType === "audio") {
          const audio = mo["audio"] as { id?: unknown; mime_type?: unknown } | undefined;
          const mediaId = str(audio?.id);
          if (!mediaId) continue;
          const dedupKey = waMsgId ? `wa:${waMsgId}` : `wa_audio:${from}:${mediaId}`;
          out.push({
            channel: "whatsapp_cloud",
            dedupKey,
            conversationKey: from,
            text: "",
            whatsappAudioMediaId: mediaId,
            customerDisplayId: from,
            sendTarget: { kind: "whatsapp_cloud", waId: from },
          });
        }
      }
    }
  }
  return out;
}

/** Messenger (object page, entry[].messaging). */
function parsePageMessaging(body: Record<string, unknown>): NormalizedMetaInbound[] {
  const entry = body["entry"];
  if (!Array.isArray(entry)) return [];
  const out: NormalizedMetaInbound[] = [];
  for (const e of entry) {
    if (!e || typeof e !== "object") continue;
    const messaging = (e as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const ev of messaging) {
      if (!ev || typeof ev !== "object") continue;
      const msg = (ev as { message?: unknown }).message;
      if (!msg || typeof msg !== "object") continue;
      const mo = msg as Record<string, unknown>;
      if (mo["is_echo"] === true) continue;
      if (mo["is_deleted"] === true) continue;
      const mid = str(mo["mid"]);
      const text = typeof mo["text"] === "object" && mo["text"] !== null
        ? str((mo["text"] as { body?: unknown }).body)
        : undefined;
      if (!text) continue;
      const sender = (ev as { sender?: { id?: unknown } }).sender;
      const psid = numStr(sender?.id);
      if (!psid) continue;
      const dedupKey = mid ? `messenger:${mid}` : `messenger:${psid}:${text.slice(0, 40)}`;
      out.push({
        channel: "messenger",
        dedupKey,
        conversationKey: `fb:${psid}`,
        text,
        customerDisplayId: `Messenger PSID ${psid}`,
        sendTarget: { kind: "messenger", psid },
      });
    }
  }
  return out;
}

/** Instagram DM (object instagram, entry[].messaging). */
function parseInstagramMessaging(body: Record<string, unknown>): NormalizedMetaInbound[] {
  const entry = body["entry"];
  if (!Array.isArray(entry)) return [];
  const out: NormalizedMetaInbound[] = [];
  for (const e of entry) {
    if (!e || typeof e !== "object") continue;
    const messaging = (e as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const ev of messaging) {
      if (!ev || typeof ev !== "object") continue;
      const msg = (ev as { message?: unknown }).message;
      if (!msg || typeof msg !== "object") continue;
      const mo = msg as Record<string, unknown>;
      if (mo["is_echo"] === true) continue;
      const mid = str(mo["mid"]);
      const text = typeof mo["text"] === "object" && mo["text"] !== null
        ? str((mo["text"] as { body?: unknown }).body)
        : undefined;
      if (!text) continue;
      const sender = (ev as { sender?: { id?: unknown } }).sender;
      const igsid = numStr(sender?.id);
      if (!igsid) continue;
      const dedupKey = mid ? `ig_msg:${mid}` : `ig_msg:${igsid}:${text.slice(0, 40)}`;
      out.push({
        channel: "instagram_dm",
        dedupKey,
        conversationKey: `ig:${igsid}`,
        text,
        customerDisplayId: `Instagram usuario ${igsid}`,
        sendTarget: { kind: "instagram_dm", igsid },
      });
    }
  }
  return out;
}

/** Comentarios en publicaciones de Facebook Page (field feed, item comment). */
function parseFacebookFeedComments(body: Record<string, unknown>): NormalizedMetaInbound[] {
  const entry = body["entry"];
  if (!Array.isArray(entry)) return [];
  const out: NormalizedMetaInbound[] = [];
  for (const e of entry) {
    if (!e || typeof e !== "object") continue;
    const pageId = numStr((e as { id?: unknown }).id);
    const changes = (e as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") continue;
      const field = str((ch as { field?: unknown }).field);
      if (field !== "feed") continue;
      const value = (ch as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const vo = value as Record<string, unknown>;
      if (str(vo["item"]) !== "comment") continue;
      if (str(vo["verb"]) !== "add") continue;
      const commentId = str(vo["comment_id"]) ?? str(vo["commentId"]);
      const postId = str(vo["post_id"]) ?? str(vo["postId"]);
      const message = str(vo["message"]);
      const fromObj = vo["from"] as { id?: unknown } | undefined;
      const fromId = numStr(fromObj?.id);
      if (!commentId || !message || !fromId) continue;
      if (pageId && fromId === pageId) continue;
      if (!postId) continue;
      out.push({
        channel: "facebook_comment",
        dedupKey: `fb_comment:${commentId}`,
        conversationKey: `fb_comment:${postId}_${fromId}`,
        text: message,
        customerDisplayId: `Comentario FB usuario ${fromId}`,
        threadHint: postId ? `https://facebook.com/${postId}` : undefined,
        sendTarget: { kind: "facebook_comment", commentId },
      });
    }
  }
  return out;
}

/** Comentarios en Instagram (field comments). */
function parseInstagramComments(body: Record<string, unknown>): NormalizedMetaInbound[] {
  const entry = body["entry"];
  if (!Array.isArray(entry)) return [];
  const out: NormalizedMetaInbound[] = [];
  for (const e of entry) {
    if (!e || typeof e !== "object") continue;
    const changes = (e as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") continue;
      const field = str((ch as { field?: unknown }).field);
      if (field !== "comments") continue;
      const value = (ch as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const vo = value as Record<string, unknown>;
      const commentId = str(vo["id"]);
      const text = str(vo["text"]);
      const fromObj = vo["from"] as { id?: unknown; username?: unknown } | undefined;
      const fromId = numStr(fromObj?.id);
      const media = vo["media"] as { id?: unknown } | undefined;
      const mediaId = numStr(media?.id);
      if (!commentId || !text || !fromId || !mediaId) continue;
      const username = str(fromObj?.username);
      out.push({
        channel: "instagram_comment",
        dedupKey: `ig_comment:${commentId}`,
        conversationKey: `ig_comment:${mediaId}_${fromId}`,
        text,
        customerDisplayId: username
          ? `Instagram @${username} (${fromId})`
          : `Instagram usuario ${fromId}`,
        threadHint: `media_id=${mediaId}`,
        sendTarget: { kind: "instagram_comment", commentId },
      });
    }
  }
  return out;
}

/**
 * Convierte el cuerpo del webhook de Meta en eventos normalizados.
 * No deduplica aquí; eso lo hace la capa superior.
 */
export function parseMetaWebhookBody(body: unknown): NormalizedMetaInbound[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const object = str(b["object"]);

  if (object === "whatsapp_business_account") {
    return parseWhatsAppCloud(b);
  }
  if (object === "page") {
    const a = parsePageMessaging(b);
    const c = parseFacebookFeedComments(b);
    return [...a, ...c];
  }
  if (object === "instagram") {
    const m = parseInstagramMessaging(b);
    const c = parseInstagramComments(b);
    return [...m, ...c];
  }
  return [];
}
