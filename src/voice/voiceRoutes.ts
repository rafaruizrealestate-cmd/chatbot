import type { Express, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import {
  buildLaraInstructions,
  LARA_PROMPT_VERSION,
  LARA_WELCOME,
} from "./manuelPrompt.js";
import {
  toolBuscarPropiedad,
  toolDerivarComercial,
  toolEnviarWhatsappCliente,
  type VoiceIntent,
} from "./realtimeTools.js";
import {
  appendVoiceTurn,
  endVoiceCall,
  getVoiceCall,
  setVoiceCallMeta,
  startVoiceCall,
} from "./voiceCallStore.js";
import { sendVoiceCallTranscriptEmail } from "./voiceLeadEmail.js";
import { recordAiAction } from "../panel/aiActions.js";
import { handleRetellCustomFunction } from "./retellFunctions.js";

function voiceAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.voiceApiKey.trim();
  if (!expected) {
    console.error("[voice/api] VOICE_API_KEY vacío: rechazando");
    res.sendStatus(403);
    return;
  }
  const header =
    req.get("x-voice-api-key") ?? req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (typeof header !== "string" || header.trim() !== expected) {
    res.sendStatus(403);
    return;
  }
  next();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const VALID_INTENTS = new Set<VoiceIntent>([
  "comprar",
  "alquilar",
  "vender",
  "alquiler_propietario",
  "traspaso",
  "visita",
  "administrativo",
  "alvaro",
]);

function asIntent(v: unknown): VoiceIntent {
  const s = str(v) ?? "";
  return VALID_INTENTS.has(s as VoiceIntent) ? (s as VoiceIntent) : "comprar";
}

export function registerVoiceRoutes(app: Express): void {
  const instructionsHandler = (req: Request, res: Response) => {
    const caller =
      str(req.query.caller) ??
      str((req.body as Record<string, unknown> | undefined)?.caller);
    res.json({
      version: LARA_PROMPT_VERSION,
      welcome: LARA_WELCOME,
      alwaysOn: config.voiceManuelAlwaysOn,
      blockedByWorkSchedule: config.voiceManuelAlwaysOn ? false : isBlockedByWorkSchedule(),
      instructions: buildLaraInstructions({ callerDigits: caller }),
    });
  };

  app.get("/voice/lara/instructions", voiceAuth, instructionsHandler);
  app.get("/voice/manuel/instructions", voiceAuth, instructionsHandler);
  // Alias legacy
  app.get("/voice/roberto/instructions", voiceAuth, instructionsHandler);

  app.post("/voice/sessions/start", voiceAuth, (req, res) => {
    const caller = str((req.body as Record<string, unknown>)?.caller);
    if (!caller) {
      res.status(400).json({ error: "caller_required" });
      return;
    }
    const id = startVoiceCall({
      caller,
      calledDid: str((req.body as Record<string, unknown>)?.called_did),
      pbxCallId: str((req.body as Record<string, unknown>)?.pbx_call_id),
    });
    res.json({ ok: true, callId: id, welcome: LARA_WELCOME });
  });

  app.post("/voice/sessions/:id/turn", voiceAuth, (req, res) => {
    const callId = String(req.params.id);
    if (!getVoiceCall(callId)) {
      res.status(404).json({ error: "call_not_found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const role = str(body?.role);
    const text = str(body?.text);
    if (role !== "user" && role !== "assistant" && role !== "system") {
      res.status(400).json({ error: "invalid_role" });
      return;
    }
    if (!text) {
      res.status(400).json({ error: "text_required" });
      return;
    }
    appendVoiceTurn(callId, role, text);
    const lang = str(body?.language);
    if (lang) setVoiceCallMeta(callId, { language: lang });
    res.json({ ok: true });
  });

  app.post("/voice/sessions/:id/end", voiceAuth, (req, res) => {
    const callId = String(req.params.id);
    const existing = getVoiceCall(callId);
    if (!existing) {
      res.status(404).json({ error: "call_not_found" });
      return;
    }
    // Idempotente: finalizar_llamada + shutdown pueden llamar /end dos veces.
    const alreadyEnded = Boolean(existing.ended_at);
    const body = req.body as Record<string, unknown>;
    endVoiceCall(callId, {
      summary: str(body?.summary) ?? null,
      intent: str(body?.intent) ?? null,
      disposition: str(body?.disposition) ?? null,
      language: str(body?.language) ?? null,
      audioPath: str(body?.audio_path) ?? null,
    });
    res.json({ ok: true });
    if (alreadyEnded) {
      return;
    }
    void sendVoiceCallTranscriptEmail(callId).catch((e) => {
      console.error("[voice/sessions] Error enviando transcripción", { callId, error: e });
    });
  });

  // Tools invocadas por el modelo Realtime (function calling).
  app.post("/voice/tools/buscar-propiedad", voiceAuth, (req, res) => {
    const b = req.body as Record<string, unknown>;
    const params = {
      ref: str(b?.ref),
      transaction_type: str(b?.transaction_type),
      property_type: str(b?.property_type),
      location_contains: str(b?.location_contains),
      max_price: num(b?.max_price),
      min_price: num(b?.min_price),
      min_bedrooms: num(b?.min_bedrooms),
      limit: num(b?.limit),
    };
    const callId = str(b?.call_id);
    const started = Date.now();
    const result = toolBuscarPropiedad(params);
    recordAiAction({
      source: "voice",
      channelId: callId,
      phone: str(b?.caller),
      tool: "buscar_propiedad",
      input: params,
      output: { count: result.count, refs: result.properties.map((p) => p.ref) },
      durationMs: Date.now() - started,
    });
    if (callId && getVoiceCall(callId)) {
      appendVoiceTurn(callId, "system", `buscar_propiedad → ${result.count} resultado(s)`);
    }
    res.json(result);
  });

  app.post("/voice/tools/derivar-comercial", voiceAuth, (req, res) => {
    const b = req.body as Record<string, unknown>;
    const caller = str(b?.caller);
    if (!caller) {
      res.status(400).json({ error: "caller_required" });
      return;
    }
    const intent = asIntent(b?.intent);
    const callId = str(b?.call_id);
    const started = Date.now();
    void toolDerivarComercial({
      caller,
      intent,
      name: str(b?.name) ?? null,
      phone: str(b?.phone) ?? null,
      email: str(b?.email) ?? null,
      ref: str(b?.ref) ?? null,
      summary: str(b?.summary) ?? null,
      callId,
      // Emails y WhatsApp salen en segundo plano: el cliente está esperando en línea.
      deferNotifications: true,
    })
      .then((result) => {
        recordAiAction({
          source: "voice",
          channelId: callId,
          phone: caller,
          tool: "derivar_comercial",
          input: { intent, name: str(b?.name), ref: str(b?.ref), summary: str(b?.summary) },
          output: result,
          ok: result.ok,
          error: result.error ?? null,
          durationMs: Date.now() - started,
        });
        if (callId && getVoiceCall(callId)) {
          setVoiceCallMeta(callId, { intent });
          const status = result.duplicated
            ? `duplicado (${result.agentName})`
            : result.ok
              ? `ok (${result.agentName})`
              : `error: ${result.error}`;
          appendVoiceTurn(callId, "system", `derivar_comercial → ${status}`);
        }
        res.json(result);
      })
      .catch((e) => {
        console.error("[voice/tools] derivar-comercial", e);
        recordAiAction({
          source: "voice",
          channelId: callId,
          phone: caller,
          tool: "derivar_comercial",
          input: { intent, ref: str(b?.ref) },
          ok: false,
          error: String(e instanceof Error ? e.message : e).slice(0, 500),
          durationMs: Date.now() - started,
        });
        res.status(500).json({ ok: false, error: "internal" });
      });
  });

  app.post("/voice/tools/enviar-whatsapp", voiceAuth, (req, res) => {
    const b = req.body as Record<string, unknown>;
    const caller = str(b?.caller);
    if (!caller) {
      res.status(400).json({ error: "caller_required" });
      return;
    }
    const callId = str(b?.call_id);
    const started = Date.now();
    void toolEnviarWhatsappCliente({
      caller,
      ref: str(b?.ref) ?? null,
      text: str(b?.text) ?? null,
    })
      .then((result) => {
        recordAiAction({
          source: "voice",
          channelId: callId,
          phone: caller,
          tool: "enviar_whatsapp",
          input: { ref: str(b?.ref), texto: str(b?.text)?.slice(0, 200) },
          output: result,
          ok: result.ok,
          error: result.error ?? null,
          durationMs: Date.now() - started,
        });
        if (callId && getVoiceCall(callId)) {
          appendVoiceTurn(
            callId,
            "system",
            `enviar_whatsapp → ${result.ok ? "enviado" : `error: ${result.error}`}`,
          );
        }
        res.json(result);
      })
      .catch((e) => {
        console.error("[voice/tools] enviar-whatsapp", e);
        recordAiAction({
          source: "voice",
          channelId: callId,
          phone: caller,
          tool: "enviar_whatsapp",
          ok: false,
          error: String(e instanceof Error ? e.message : e).slice(0, 500),
          durationMs: Date.now() - started,
        });
        res.status(500).json({ ok: false, error: "internal" });
      });
  });

  /** Custom functions de Retell AI (mismas tools, formato Retell). Header X-Voice-Api-Key. */
  app.post("/voice/retell/function", voiceAuth, (req, res) => {
    void handleRetellCustomFunction(req, res);
  });
}
