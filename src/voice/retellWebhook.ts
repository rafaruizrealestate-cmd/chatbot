import type { Request, Response } from "express";
import { endVoiceCall, getVoiceCallByPbxId, startVoiceCall } from "./voiceCallStore.js";

type RetellWebhookBody = {
  event?: string;
  call?: {
    call_id?: string;
    from_number?: string;
    to_number?: string;
    transcript?: string;
    disconnection_reason?: string;
  };
};

/** Webhook Retell: call_started / call_ended → archivo en voice_calls. */
export function handleRetellWebhook(req: Request, res: Response): void {
  const body = req.body as RetellWebhookBody;
  const event = (body.event ?? "").trim();
  const call = body.call;

  if (!call?.call_id) {
    res.sendStatus(200);
    return;
  }

  const retellId = call.call_id;
  const caller = (call.from_number ?? "").replace(/\D+/g, "");

  if (event === "call_started" && caller) {
    const existing = getVoiceCallByPbxId(retellId);
    if (!existing) {
      startVoiceCall({
        caller,
        calledDid: (call.to_number ?? "").replace(/\D+/g, ""),
        pbxCallId: retellId,
      });
    }
    console.log("[voice/retell] call_started", { retellId: retellId.slice(0, 8) });
  }

  if (event === "call_ended") {
    const row = getVoiceCallByPbxId(retellId);
    if (row && !row.ended_at) {
      endVoiceCall(row.id, {
        disposition: call.disconnection_reason ?? "ended",
        summary: (call.transcript ?? "").slice(0, 2000) || null,
      });
    }
    console.log("[voice/retell] call_ended", { retellId: retellId.slice(0, 8) });
  }

  res.sendStatus(200);
}
