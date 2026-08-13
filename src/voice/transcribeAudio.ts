import OpenAI from "openai";
import { assertOpenAiConfigured, config } from "../config.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    assertOpenAiConfigured();
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return client;
}

/**
 * Transcribe audio (p. ej. nota de voz WhatsApp) con Whisper.
 * `filename` debe llevar extensión coherente con el mime (ogg, webm, m4a…).
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
  language?: string
): Promise<string> {
  const openai = getClient();
  const lower = filename.toLowerCase();
  const type =
    lower.endsWith(".mp3") || lower.endsWith(".mpeg")
      ? "audio/mpeg"
      : lower.endsWith(".m4a") || lower.endsWith(".mp4")
        ? "audio/mp4"
        : lower.endsWith(".wav")
          ? "audio/wav"
          : lower.endsWith(".webm")
            ? "audio/webm"
            : "audio/ogg";
  const file = new File([buffer], filename, { type });
  const tr = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: language === "en" ? "en" : "es",
  });
  const text = typeof tr === "string" ? tr : (tr as { text?: string }).text ?? "";
  return text.trim();
}
