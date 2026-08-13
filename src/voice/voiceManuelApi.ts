import type { Request, Response } from "express";
import { config } from "../config.js";
import { runManuelVoiceTurn } from "./voiceManuel.js";

function checkVoiceApiKey(req: Request): boolean {
  const expected = config.voiceApiKey.trim();
  if (!expected) {
    console.error("[voice/lara] VOICE_API_KEY vacío: rechazando");
    return false;
  }
  const header =
    req.get("x-voice-api-key") ?? req.get("authorization")?.replace(/^Bearer\s+/i, "");
  return typeof header === "string" && header.trim() === expected;
}

export async function handleVoiceManuelReply(req: Request, res: Response): Promise<void> {
  if (!checkVoiceApiKey(req)) {
    res.sendStatus(403);
    return;
  }

  const body = req.body as Record<string, unknown>;
  const from = typeof body.from === "string" ? body.from : "";
  const text = typeof body.text === "string" ? body.text : "";
  const displayFrom = typeof body.display_from === "string" ? body.display_from : undefined;

  if (!from.trim() || !text.trim()) {
    res.status(400).json({ error: "from_and_text_required" });
    return;
  }

  try {
    const reply = await runManuelVoiceTurn(from, text, displayFrom);
    res.json({ reply });
  } catch (e) {
    console.error("[voice/lara] error", e);
    res.status(500).json({
      error: "lara_failed",
    });
  }
}
