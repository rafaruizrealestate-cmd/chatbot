import type { Request, Response } from "express";
import { config } from "../config.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";
import { assertZadarmaRequest, zadarmaParams } from "./zadarmaAuth.js";
import { endVoiceCall, getVoiceCallByPbxId } from "./voiceCallStore.js";

function normalizeDid(input: string | undefined): string {
  return (input ?? "").replace(/\D+/g, "");
}

function isTrackedZadarmaNumber(calledDid: string): boolean {
  const targets = config.zadarmaTrackedNumbers;
  if (targets.length === 0) return true;
  const called = normalizeDid(calledDid);
  return targets.some((t) => called.endsWith(normalizeDid(t)) || normalizeDid(t).endsWith(called));
}

/** Verificación de URL (Zadarma envía ?zd_echo=...). */
export function handleZadarmaWebhookGet(req: Request, res: Response): void {
  const echo = req.query.zd_echo;
  if (typeof echo === "string" && echo.trim()) {
    res.type("text/plain").send(echo);
    return;
  }
  res.sendStatus(200);
}

/** Notificaciones PBX: NOTIFY_START, NOTIFY_END, NOTIFY_ANSWER… */
export function handleZadarmaWebhookPost(req: Request, res: Response): void {
  if (!config.zadarmaEnabled) {
    res.sendStatus(404);
    return;
  }

  const params = zadarmaParams(req);
  const event = (params.event ?? "").trim().toUpperCase();
  if (!event) {
    res.sendStatus(200);
    return;
  }

  if (!assertZadarmaRequest(req, event)) {
    console.warn("[voice/zadarma] firma inválida", { event });
    res.sendStatus(403);
    return;
  }

  const calledDid = params.called_did ?? params.destination ?? "";
  const callerId = params.caller_id ?? "";
  if (!isTrackedZadarmaNumber(calledDid)) {
    console.log("[voice/zadarma] evento ignorado (número no monitorizado)", { event, calledDid });
    res.json({});
    return;
  }

  console.log("[voice/zadarma] evento", {
    event,
    callerId: callerId.slice(0, 6) + "…",
    calledDid,
    disposition: params.disposition ?? null,
    pbxCallId: params.pbx_call_id ?? null,
  });

  if (event === "NOTIFY_START") {
    if (config.voiceManuelEnabled && config.voiceManuelAlwaysOn) {
      res.json({ caller_name: `${config.botName} — Inmobiliaria Bazán` });
      return;
    }
    if (isBlockedByWorkSchedule()) {
      res.json({
        caller_name: `${config.botName} IA (fuera de servicio en horario laboral)`,
      });
      return;
    }
    res.json({ caller_name: `${config.botName} IA Bazán` });
    return;
  }

  if (event === "NOTIFY_END") {
    const disposition = (params.disposition ?? "").toLowerCase();
    const pbxCallId = (params.pbx_call_id ?? "").trim();

    // Correlaciona con la llamada que abrió el worker LiveKit (mismo pbx_call_id).
    if (pbxCallId) {
      const call = getVoiceCallByPbxId(pbxCallId);
      if (call && !call.ended_at) {
        endVoiceCall(call.id, { disposition: disposition || "ended" });
      }
    }

    if (disposition === "no answer" || disposition === "cancel" || disposition === "failed") {
      console.log("[voice/zadarma] llamada no atendida", {
        callerId: callerId.slice(0, 8),
        calledDid,
        disposition,
      });
    }
    res.json({});
    return;
  }

  res.json({});
}
