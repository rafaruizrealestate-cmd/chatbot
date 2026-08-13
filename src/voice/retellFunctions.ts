import type { Request, Response } from "express";
import {
  toolBuscarPropiedad,
  toolDerivarComercial,
  toolEnviarEmailCliente,
  toolEnviarWhatsappCliente,
  type VoiceIntent,
} from "./realtimeTools.js";
import { appendVoiceTurn, getVoiceCallByPbxId, startVoiceCall } from "./voiceCallStore.js";

type RetellCall = {
  call_id?: string;
  from_number?: string;
  to_number?: string;
  transcript?: string;
};

type RetellFunctionBody = {
  name?: string;
  call?: RetellCall;
  args?: Record<string, unknown>;
};

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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function callerDigits(call: RetellCall | undefined): string {
  return (call?.from_number ?? "").replace(/\D+/g, "");
}

function asIntent(v: unknown): VoiceIntent {
  const s = str(v) ?? "";
  return VALID_INTENTS.has(s as VoiceIntent) ? (s as VoiceIntent) : "comprar";
}

/** Asegura call_id de Retell correlacionado con voice_calls (por retell call_id en pbx_call_id). */
function ensureCallSession(call: RetellCall | undefined): string | null {
  const retellId = str(call?.call_id);
  if (!retellId) return null;
  const existing = getVoiceCallByPbxId(retellId);
  if (existing) return existing.id;
  const caller = callerDigits(call);
  if (!caller) return null;
  return startVoiceCall({
    caller,
    calledDid: (call?.to_number ?? "").replace(/\D+/g, ""),
    pbxCallId: retellId,
  });
}

export async function handleRetellCustomFunction(req: Request, res: Response): Promise<void> {
  const body = req.body as RetellFunctionBody;
  const name = str(body.name);
  const args = body.args ?? {};
  const call = body.call;

  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  const callId = ensureCallSession(call);
  const caller = callerDigits(call);

  try {
    if (name === "buscar_propiedad") {
      const result = toolBuscarPropiedad({
        ref: str(args.ref),
        transaction_type: str(args.transaction_type),
        property_type: str(args.property_type),
        location_contains: str(args.location_contains),
        max_price: num(args.max_price),
        min_price: num(args.min_price),
        min_bedrooms: num(args.min_bedrooms),
        limit: num(args.limit),
      });
      if (callId) {
        appendVoiceTurn(callId, "system", `buscar_propiedad → ${result.count} resultado(s)`);
      }
      res.json({
        result: result.count
          ? result.properties.map((p) => p.summary).join("\n\n")
          : "No encontré inmuebles con esos criterios.",
        properties: result.properties,
      });
      return;
    }

    if (name === "derivar_comercial") {
      if (!caller) {
        res.status(400).json({ error: "caller_required" });
        return;
      }
      const intent = asIntent(args.intent);
      const result = await toolDerivarComercial({
        caller,
        intent,
        name: str(args.name) ?? null,
        phone: str(args.phone) ?? null,
        email: str(args.email) ?? null,
        ref: str(args.ref) ?? null,
        summary: str(args.summary) ?? null,
        callId,
      });
      if (callId) {
        const status = result.duplicated
          ? `duplicado (${result.agentName})`
          : result.ok
            ? `ok (${result.agentName})`
            : result.error;
        appendVoiceTurn(callId, "system", `derivar_comercial → ${status}`);
      }
      res.json({
        result: result.duplicated
          ? `Lead ya enviado al comercial ${result.agentName ?? ""} (sin reenviar emails).`
          : result.ok
            ? `Lead enviado al comercial ${result.agentName ?? ""} (WhatsApp y/o email).`
            : `No se pudo avisar al comercial: ${result.error ?? "error"}`,
        ...result,
      });
      return;
    }

    if (name === "enviar_email_cliente") {
      const email = str(args.email);
      if (!email) {
        res.status(400).json({ error: "email_required" });
        return;
      }
      const result = await toolEnviarEmailCliente({
        email,
        name: str(args.name) ?? null,
        ref: str(args.ref) ?? null,
        text: str(args.text) ?? null,
        intent: asIntent(args.intent),
      });
      res.json({
        result: result.ok
          ? "Email enviado al cliente con la información solicitada."
          : `No se pudo enviar email: ${result.error ?? "error"}`,
        ...result,
      });
      return;
    }

    if (name === "enviar_whatsapp_cliente") {
      if (!caller) {
        res.status(400).json({ error: "caller_required" });
        return;
      }
      const result = await toolEnviarWhatsappCliente({
        caller,
        ref: str(args.ref) ?? null,
        text: str(args.text) ?? null,
      });
      res.json({
        result: result.ok
          ? "Mensaje enviado al cliente por WhatsApp."
          : `No se pudo enviar WhatsApp: ${result.error ?? "error"}`,
        ...result,
      });
      return;
    }

    res.status(404).json({ error: "unknown_function", name });
  } catch (e) {
    console.error("[voice/retell/function]", name, e);
    res.status(500).json({ error: "internal" });
  }
}
