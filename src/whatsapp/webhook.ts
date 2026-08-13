import type { Request, Response } from "express";
import { config } from "../config.js";
import { sendWhatsAppText } from "./sender.js";
import { processIncomingText, type ProcessIncomingContext } from "./processIncomingText.js";
import { verifyMetaWebhookSignature } from "../meta/signature.js";
import { parseMetaWebhookBody } from "../meta/parseWebhook.js";
import type { NormalizedMetaInbound } from "../meta/types.js";
import {
  sendMessengerText,
  sendInstagramDmText,
  replyToFacebookComment,
  replyToInstagramComment,
} from "../meta/senders.js";
import { tryClaimMetaDedup } from "../db/metaDedup.js";
import type { ContactChannelHint } from "../ai/openai.js";
import { downloadWhatsAppCloudMediaBuffer, logWaMediaError } from "../meta/waCloudMedia.js";
import { transcribeAudioBuffer } from "../voice/transcribeAudio.js";

function firstQueryString(val: unknown): string | undefined {
  if (typeof val === "string" && val.length > 0) return val;
  if (Array.isArray(val)) {
    const x = val[0];
    if (typeof x === "string" && x.length > 0) return x;
  }
  return undefined;
}

export function handleWebhookVerify(req: Request, res: Response): void {
  const mode = firstQueryString(req.query["hub.mode"]);
  const token = firstQueryString(req.query["hub.verify_token"]);
  const challenge = firstQueryString(req.query["hub.challenge"]);
  const expected = config.webhookVerifyToken;

  if (mode === "subscribe" && token === expected && challenge !== undefined) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }

  console.warn("[webhook] Verificación GET fallida", {
    mode,
    tokenMatch: token === expected,
    hasChallenge: challenge !== undefined,
    expectedLen: expected.length,
    gotTokenLen: token?.length ?? 0,
  });
  res.sendStatus(403);
}

function metaChannelToLeadContext(ev: NormalizedMetaInbound): ProcessIncomingContext {
  const leadChannel: ContactChannelHint =
    ev.channel === "whatsapp_cloud"
      ? "whatsapp"
      : ev.channel === "messenger"
        ? "messenger"
        : ev.channel === "instagram_dm"
          ? "instagram_dm"
          : ev.channel === "facebook_comment"
            ? "facebook_comment"
            : "instagram_comment";
  return {
    leadChannel,
    customerDisplayId: ev.customerDisplayId,
    threadUrl: ev.threadHint,
  };
}

function shouldHandleSocialEvent(ev: NormalizedMetaInbound): boolean {
  if (ev.channel === "whatsapp_cloud") return true;
  const tokenOk = config.metaPageAccessToken.trim().length > 0;
  if (!tokenOk) return false;
  if (ev.channel === "messenger" || ev.channel === "facebook_comment") {
    return config.metaFbEnabled;
  }
  if (ev.channel === "instagram_dm" || ev.channel === "instagram_comment") {
    return config.metaIgEnabled;
  }
  return false;
}

async function sendCustomerReply(ev: NormalizedMetaInbound, body: string): Promise<void> {
  const text = body.trim();
  if (!text) return;

  switch (ev.sendTarget.kind) {
    case "whatsapp_cloud": {
      if (config.whatsappToken && config.whatsappPhoneId) {
        await sendWhatsAppText(ev.sendTarget.waId, text);
        console.log("[webhook] Respuesta enviada por WhatsApp", { to: ev.sendTarget.waId, len: text.length });
      } else {
        console.warn("[webhook] WhatsApp no configurado; respuesta solo en log:", text.slice(0, 200));
      }
      return;
    }
    case "messenger": {
      await sendMessengerText(ev.sendTarget.psid, text);
      console.log("[webhook] Respuesta Messenger", { psid: ev.sendTarget.psid, len: text.length });
      return;
    }
    case "instagram_dm": {
      await sendInstagramDmText(ev.sendTarget.igsid, text);
      console.log("[webhook] Respuesta Instagram DM", { igsid: ev.sendTarget.igsid, len: text.length });
      return;
    }
    case "facebook_comment": {
      await replyToFacebookComment(ev.sendTarget.commentId, text);
      console.log("[webhook] Respuesta comentario FB", { commentId: ev.sendTarget.commentId, len: text.length });
      return;
    }
    case "instagram_comment": {
      await replyToInstagramComment(ev.sendTarget.commentId, text);
      console.log("[webhook] Respuesta comentario IG", { commentId: ev.sendTarget.commentId, len: text.length });
      return;
    }
    default:
      return;
  }
}

function buildSendText(ev: NormalizedMetaInbound): (to: string, body: string) => Promise<void> {
  const convKey = ev.conversationKey;
  return async (to: string, body: string) => {
    if (to === convKey) {
      try {
        await sendCustomerReply(ev, body);
      } catch (err) {
        console.error("[webhook] Error enviando respuesta al cliente", err);
      }
      return;
    }
    if (config.whatsappToken && config.whatsappPhoneId) {
      await sendWhatsAppText(to, body);
      console.log("[webhook] Notificación a agente por WhatsApp", { to, len: body.length });
      return;
    }
    console.warn("[webhook] Sin WHATSAPP_TOKEN: no se puede notificar al agente", { toPrefix: to.slice(0, 8) });
  };
}

export async function handleWebhookPost(req: Request, res: Response): Promise<void> {
  if (config.metaAppSecret) {
    const sig = req.get("x-hub-signature-256");
    const ok = verifyMetaWebhookSignature(req.rawBody, sig, config.metaAppSecret);
    if (!ok) {
      console.warn("[webhook] Firma Meta inválida o falta rawBody (¿verify en express.json?)");
      res.sendStatus(403);
      return;
    }
  }

  res.sendStatus(200);

  const events = parseMetaWebhookBody(req.body);
  if (events.length === 0) {
    return;
  }

  for (const ev of events) {
    if (!shouldHandleSocialEvent(ev)) {
      continue;
    }
    if (!tryClaimMetaDedup(ev.dedupKey)) {
      continue;
    }

    console.log("[webhook] Evento entrante", {
      channel: ev.channel,
      conversationKey: ev.conversationKey,
      preview: ev.whatsappAudioMediaId ? `(audio ${ev.whatsappAudioMediaId})` : ev.text.slice(0, 80),
    });

    const ctx = metaChannelToLeadContext(ev);
    void (async () => {
      let userText = ev.text.trim();
      if (ev.channel === "whatsapp_cloud" && ev.whatsappAudioMediaId) {
        try {
          const buf = await downloadWhatsAppCloudMediaBuffer(ev.whatsappAudioMediaId);
          userText = (await transcribeAudioBuffer(buf, `wa-${ev.whatsappAudioMediaId}.ogg`, "es")).trim();
        } catch (e) {
          logWaMediaError(e, ev.whatsappAudioMediaId);
          try {
            await sendCustomerReply(
              ev,
              "No he podido transcribir la nota de voz. ¿Puedes repetirla o escribir tu consulta en texto?"
            );
          } catch (sendErr) {
            console.error("[webhook] Error enviando disculpa tras fallo de audio", sendErr);
          }
          return;
        }
      }
      if (!userText) {
        console.log("[webhook] Sin texto tras parseo/transcripción; se ignora");
        return;
      }
      await processIncomingText(ev.conversationKey, userText, buildSendText(ev), undefined, ctx);
    })().catch((err) => {
      console.error("[webhook] processIncomingText", err);
    });
  }
}
