import axios from "axios";
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

/** Voces OpenAI TTS; `onyx` = masculina (fallback). */
const DEFAULT_VOICE = "onyx" as const;

/** Acento castellano peninsular / madrileño nativo para gpt-4o-mini-tts. */
const MADRID_ES_INSTRUCTIONS =
  "Speak in native Castilian Spanish from Madrid, Spain (español de España, acento madrileño). " +
  "Male, warm, clear, natural WhatsApp tone. " +
  "Use Spain Spanish pronunciation (c/z as th, soft s). Never use a Latin American accent.";

function prepareSpokenText(text: string, maxChars: number): string {
  let spoken = text.trim().replace(/\s+/g, " ");
  if (spoken.length > maxChars) {
    spoken = `${spoken.slice(0, maxChars - 1).trim()}…`;
  }
  return spoken
    .replace(/https?:\/\/\S+/gi, "enlace en el chat")
    .replace(/\bwww\.\S+/gi, "enlace en el chat")
    .replace(/\*\*?/g, "")
    .replace(/[_`#]/g, "")
    .trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function useAzureTts(): boolean {
  const provider = config.ttsProvider;
  const hasAzure = Boolean(config.azureSpeechKey && config.azureSpeechRegion);
  if (provider === "azure") return hasAzure;
  if (provider === "openai") return false;
  return hasAzure; // auto
}

/** Azure Speech REST → MP3 (es-ES-AlvaroNeural por defecto). */
async function synthesizeAzureMp3(spoken: string): Promise<Buffer> {
  const region = config.azureSpeechRegion;
  const voice = config.azureSpeechVoice;
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml =
    `<speak version='1.0' xml:lang='es-ES'>` +
    `<voice xml:lang='es-ES' name='${escapeXml(voice)}'>` +
    `<prosody rate='0%' pitch='0%'>${escapeXml(spoken)}</prosody>` +
    `</voice></speak>`;

  const res = await axios.post(url, ssml, {
    headers: {
      "Ocp-Apim-Subscription-Key": config.azureSpeechKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "whatsapp-chatbot-951",
    },
    responseType: "arraybuffer",
    timeout: 60000,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    const errBody = Buffer.isBuffer(res.data)
      ? Buffer.from(res.data).toString("utf8").slice(0, 300)
      : String(res.data).slice(0, 300);
    throw new Error(`Azure TTS HTTP ${res.status}: ${errBody}`);
  }
  return Buffer.from(res.data);
}

async function synthesizeOpenAiMp3(
  spoken: string,
  opts?: { voice?: "nova" | "alloy" | "echo" | "fable" | "onyx" | "shimmer" },
): Promise<Buffer> {
  const openai = getClient();
  const allowed = new Set(["nova", "alloy", "echo", "fable", "onyx", "shimmer"]);
  const rawVoice = (opts?.voice ?? config.whatsappTtsVoice ?? DEFAULT_VOICE).toLowerCase();
  const voice = (allowed.has(rawVoice) ? rawVoice : DEFAULT_VOICE) as
    | "nova"
    | "alloy"
    | "echo"
    | "fable"
    | "onyx"
    | "shimmer";

  try {
    const res = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: spoken,
      instructions: MADRID_ES_INSTRUCTIONS,
      response_format: "mp3",
    });
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn("[tts] gpt-4o-mini-tts falló; uso tts-1", e instanceof Error ? e.message : e);
    const res = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: spoken,
      response_format: "mp3",
    });
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Sintetiza voz (MP3) a partir de texto para notas de WhatsApp.
 * Preferencia: Azure es-ES (barato, acento España) → OpenAI fallback.
 */
export async function synthesizeSpeechMp3(
  text: string,
  opts?: { voice?: "nova" | "alloy" | "echo" | "fable" | "onyx" | "shimmer"; maxChars?: number },
): Promise<Buffer> {
  const maxChars = opts?.maxChars ?? 1200;
  const spoken = prepareSpokenText(text, maxChars);
  if (!spoken) throw new Error("texto vacío para TTS");

  if (useAzureTts()) {
    try {
      const buf = await synthesizeAzureMp3(spoken);
      console.log("[tts] azure", { voice: config.azureSpeechVoice, bytes: buf.length });
      return buf;
    } catch (e) {
      console.warn("[tts] Azure falló; fallback OpenAI", e instanceof Error ? e.message : e);
    }
  }

  return synthesizeOpenAiMp3(spoken, opts);
}
