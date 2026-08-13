import "dotenv/config";
import path from "node:path";
import { mkdirSync } from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dbPath = optional("DATABASE_PATH", "./data/manuel.db");
const propertiesDbPath = (process.env.PROPERTIES_DATABASE_PATH ?? "").trim() || dbPath;
const dbDir = path.dirname(dbPath);
try {
  mkdirSync(dbDir, { recursive: true });
} catch {
  // ignore
}

function parseAgentNotifyChannel(raw: string): "email" | "whatsapp" | "both" {
  const v = raw.trim().toLowerCase();
  if (v === "both") return "both";
  if (v === "whatsapp" || v === "wa") return "whatsapp";
  return "email";
}

function parseBotLoopGuardMode(raw: string): "off" | "rate" | "full" {
  const v = raw.trim().toLowerCase();
  if (v === "full" || v === "1") return "full";
  if (v === "off" || v === "0") return "off";
  return "rate";
}

function parsePhoneList(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const digits = part.replace(/\D+/g, "");
    if (digits) out.add(digits);
  }
  return out;
}

function parsePhoneEmailMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const phone = part.slice(0, idx).replace(/\D+/g, "");
    const email = part.slice(idx + 1).trim().toLowerCase();
    if (phone && email.includes("@")) map.set(phone, email);
  }
  return map;
}

export const config = {
  /** Nombre del asistente (WhatsApp, voz, emails). */
  botName: optional("BOT_NAME", "Manuel"),
  emailFromName: optional("EMAIL_FROM_NAME", "Manuel - Inmobiliaria Bazán"),
  opsAlertPrefix: optional("OPS_ALERT_PREFIX", "Manuel"),
  /**
   * email | whatsapp | both — aviso de leads a comerciales.
   * Por defecto both: WhatsApp a menudo falla en entrega sin @lid; el email es la red de seguridad.
   */
  agentNotifyChannel: parseAgentNotifyChannel(process.env.AGENT_NOTIFY_CHANNEL ?? "both"),

  whatsappProvider: (process.env.WHATSAPP_PROVIDER ?? "meta").toLowerCase(),
  whatsappToken: process.env.WHATSAPP_TOKEN ?? "",
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID ?? "",
  webhookVerifyToken: (process.env.WEBHOOK_VERIFY_TOKEN ?? "").trim(),
  evolutionBaseUrl: (process.env.EVOLUTION_BASE_URL ?? "").trim(),
  evolutionApiKey: (process.env.EVOLUTION_API_KEY ?? "").trim(),
  // Opcional: si no se define, se intentará usar `instance` del webhook.
  evolutionInstance: (process.env.EVOLUTION_INSTANCE ?? "").trim(),
  /**
   * 1 = permitir WhatsApp proactivo a desconocidos (portales, llamada perdida, ficha tras voz).
   * 0 (defecto Lara) = solo responder a quien escriba primero por WhatsApp.
   */
  whatsappProactiveOutreach: (process.env.WHATSAPP_PROACTIVE_OUTREACH ?? "0").trim() === "1",
  /** 1 = si el cliente manda nota de voz, Lara responde también con nota de voz (TTS). */
  whatsappVoiceReply: (process.env.WHATSAPP_VOICE_REPLY ?? "1").trim() === "1",
  /**
   * Anti-bucle: off = nunca silencia · rate (defecto) = solo cadencia extrema
   * · full = añade detección de repetición (da falsos positivos con clientes reales).
   */
  whatsappBotLoopGuard: parseBotLoopGuardMode(process.env.WHATSAPP_BOT_LOOP_GUARD ?? "rate"),
  /** Números (E.164 sin +) que el anti-bucle nunca puede silenciar. */
  whatsappNeverMutePhones: parsePhoneList(
    process.env.WHATSAPP_NEVER_MUTE_PHONES ?? "34646424563",
  ),
  /** Voz OpenAI TTS (fallback): nova | alloy | echo | fable | onyx | shimmer */
  whatsappTtsVoice: (process.env.WHATSAPP_TTS_VOICE ?? "onyx").trim() || "onyx",
  /**
   * Proveedor TTS: azure | openai | auto (azure si hay clave, si no openai).
   * Azure: español de España barato (es-ES-AlvaroNeural).
   */
  ttsProvider: (process.env.TTS_PROVIDER ?? "openai").trim().toLowerCase() || "openai",
  azureSpeechKey: (process.env.AZURE_SPEECH_KEY ?? "").trim(),
  azureSpeechRegion: (process.env.AZURE_SPEECH_REGION ?? "westeurope").trim() || "westeurope",
  azureSpeechVoice: (process.env.AZURE_SPEECH_VOICE ?? "es-ES-AlvaroNeural").trim() || "es-ES-AlvaroNeural",

  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  adminApiKey: process.env.ADMIN_API_KEY ?? "",
  scrapeTargetUrl: optional("SCRAPE_TARGET_URL", "https://www.inmobiliariabazan.com"),
  /** 0 = no ejecutar scrape en deploy (usa PROPERTIES_DATABASE_PATH compartido con Leo). */
  scrapeEnabled: (process.env.SCRAPE_ENABLED ?? "0").trim() === "1",
  databasePath: dbPath,
  /** Catálogo de inmuebles (solo lectura si distinto de databasePath). En VPS: /opt/whatsapp-chatbot/data/chatbot.db */
  propertiesDatabasePath: propertiesDbPath,
  port: optionalInt("PORT", 3002),
  // Garantía de contexto: al menos los últimos 5 mensajes del hilo (user+assistant).
  maxConversationHistory: Math.max(optionalInt("MAX_CONVERSATION_HISTORY", 20), 5),
  conversationTtlHours: optionalInt("CONVERSATION_TTL_HOURS", 24),
  maxKnowledgeChunks: optionalInt("MAX_KNOWLEDGE_CHUNKS", 5),
  openaiChatModel: optional("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
  openaiEmbeddingModel: optional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),

  /** SMTP configurado (puede enviar aunque EMAIL_ENABLED=0 sin IMAP). */
  emailEnabled: (process.env.EMAIL_ENABLED ?? "0") === "1",
  imapHost: optional("IMAP_HOST", "mail.inmobiliariabazan.com"),
  imapPort: optionalInt("IMAP_PORT", 993),
  smtpHost: optional("SMTP_HOST", "mail.inmobiliariabazan.com"),
  smtpPort: optionalInt("SMTP_PORT", 465),
  emailUser: process.env.EMAIL_USER ?? "",
  emailPass: process.env.EMAIL_PASS ?? "",
  /** SMTP listo (envío saliente sin IMAP). */
  smtpConfigured: Boolean(process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASS?.trim()),
  /** Opcional: fuerza el nombre de carpeta IMAP para Enviados (Sent/Enviados/INBOX.Sent...). */
  emailSentMailbox: (process.env.EMAIL_SENT_MAILBOX ?? "").trim(),
  /** 1 = archiva también las respuestas WhatsApp dentro de Enviados (solo IMAP APPEND, no envía email). */
  emailArchiveWhatsappToSent: (process.env.EMAIL_ARCHIVE_WHATSAPP_TO_SENT ?? "0").trim() === "1",

  /** WhatsApp de alertas operativas (solo dígitos, p. ej. 34646424563). */
  opsAlertWhatsapp: (process.env.OPS_ALERT_WHATSAPP ?? "34646424563").trim(),
  /** Fallback email si falla WhatsApp. */
  opsAlertEmail: (process.env.OPS_ALERT_EMAIL ?? "alvaro@inmobiliariabazan.com").trim(),
  /** Máx. envíos al mismo destinatario por hora (anti-bucle). */
  emailMaxSendsPerRecipientHour: optionalInt("EMAIL_MAX_SENDS_PER_RECIPIENT_HOUR", 3),
  /** Máx. envíos SMTP por ejecución de email:poll. */
  emailMaxSendsPerPoll: optionalInt("EMAIL_MAX_SENDS_PER_POLL", 5),
  /** Umbral de envíos en 10 min para alertar por volumen anómalo. */
  emailAlertThresholdTotal10Min: optionalInt("EMAIL_ALERT_THRESHOLD_TOTAL_10MIN", 10),
  /** Destinos @inmobiliariabazan permitidos (p. ej. reenvíos internos). */
  emailOutboundAllowlist: (process.env.EMAIL_OUTBOUND_ALLOWLIST ?? "alvaro@inmobiliariabazan.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** Secreto de la app Meta (firma X-Hub-Signature-256). Vacío = no validar firma. */
  metaAppSecret: (process.env.META_APP_SECRET ?? "").trim(),
  /** Page access token (Messenger, Instagram conectado a la Page, respuestas a comentarios). */
  metaPageAccessToken: (process.env.META_PAGE_ACCESS_TOKEN ?? "").trim(),
  /** 1 = Messenger + comentarios en posts de Facebook Page */
  metaFbEnabled: (process.env.META_FB_ENABLED ?? "0").trim() === "1",
  /** 1 = DM Instagram + comentarios Instagram */
  metaIgEnabled: (process.env.META_IG_ENABLED ?? "0").trim() === "1",

  /** Retención de histórico de llamadas de voz (voice_calls, grabaciones). */
  voiceRetentionDays: optionalInt("VOICE_RETENTION_DAYS", 90),

  /** 1 = expone GET/POST /webhook/zadarma (notificaciones PBX Zadarma). */
  zadarmaEnabled: (process.env.ZADARMA_ENABLED ?? "0").trim() === "1",
  zadarmaApiSecret: (process.env.ZADARMA_API_SECRET ?? "").trim(),
  /** Solo desarrollo: 1 = no validar firma HMAC de Zadarma. */
  zadarmaSkipSignatureVerify: (process.env.ZADARMA_SKIP_SIGNATURE_VERIFY ?? "0").trim() === "1",
  /** DIDs monitorizados (solo dígitos, separados por coma). Por defecto +34 951 870 058. */
  zadarmaTrackedNumbers: (process.env.ZADARMA_TRACKED_NUMBERS ?? "34951870058")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Clave para POST /voice/lara/reply (LiveKit u otro STT/TTS). Header X-Voice-Api-Key. */
  voiceApiKey: (process.env.VOICE_API_KEY ?? "").trim(),

  /** 1 = WhatsApp y emails 24/7 (sin pausa L-V 10:00–19:30). Lara: activo por defecto. */
  bypassWorkSchedule: (process.env.BYPASS_WORK_SCHEDULE ?? "1").trim() === "1",

  /** 1 = expone las rutas del agente de voz Lara (/voice/sessions/*, /voice/tools/*). */
  voiceManuelEnabled: (
    process.env.VOICE_LARA_ENABLED ??
    process.env.VOICE_MANUEL_ENABLED ??
    process.env.VOICE_ROBERTO_ENABLED ??
    "0"
  ).trim() === "1",
  /** 1 = Lara (voz) contesta 24/7 (ignora el bloqueo horario de WhatsApp). */
  voiceManuelAlwaysOn: (
    process.env.VOICE_LARA_ALWAYS_ON ??
    process.env.VOICE_MANUEL_ALWAYS_ON ??
    process.env.VOICE_ROBERTO_ALWAYS_ON ??
    "1"
  ).trim() === "1",
  /** Comercial por defecto para leads de compra/alquiler/visita (voz). */
  voiceBuyerAgentName: (process.env.VOICE_BUYER_AGENT_NAME ?? "Miguel").trim(),
  voiceBuyerAgentPhone: (process.env.VOICE_BUYER_AGENT_PHONE ?? "34620555989").trim(),
  /** Comercial por defecto para propietarios/traspasos (voz). */
  voiceOwnerAgentName: (process.env.VOICE_OWNER_AGENT_NAME ?? "Álvaro").trim(),
  voiceOwnerAgentPhone: (process.env.VOICE_OWNER_AGENT_PHONE ?? "34646424563").trim(),
  /** Persona de administración a la que se deriva cuando piden hablar con un humano. */
  voiceAdminName: (process.env.VOICE_ADMIN_NAME ?? "Ángela").trim(),
  /** Teléfono del administrativo (tienda) para callbacks L-V. */
  voiceAdminPhone: (process.env.VOICE_ADMIN_PHONE ?? "34672594724").trim(),
  /** Email del administrativo para leads de callback / humano. */
  voiceAdminEmail: (process.env.VOICE_ADMIN_EMAIL ?? "admin@inmobiliariabazan.com").trim(),
  /** Directorio donde el worker guarda las grabaciones de audio. */
  voiceRecordingsDir: (process.env.VOICE_RECORDINGS_DIR ?? "./data/voice-recordings").trim(),

  /** 1 (defecto) = sirve el panel web en /panel con login propio. */
  panelEnabled: (process.env.PANEL_ENABLED ?? "1").trim() === "1",
  /** Duración de la sesión del panel (se renueva sola mientras se use). */
  panelSessionHours: Math.max(optionalInt("PANEL_SESSION_HOURS", 12), 1),
  /** Admin inicial: solo se usa si la tabla de usuarios está vacía. */
  panelAdminUser: (process.env.PANEL_ADMIN_USER ?? "").trim(),
  panelAdminPassword: process.env.PANEL_ADMIN_PASSWORD ?? "",
  /** 1 = cookie de sesión solo por HTTPS. Ponlo a 1 cuando el panel esté tras dominio TLS. */
  panelSecureCookie: (process.env.PANEL_SECURE_COOKIE ?? "0").trim() === "1",
  /** Fichero de estado que escribe scripts/manuel-healthcheck.sh. */
  panelHealthStatusFile: (
    process.env.PANEL_HEALTH_STATUS_FILE ?? "/var/lib/manuel-health/last.status"
  ).trim(),

  /** 1 = expone POST /webhook/retell (call_started / call_ended → voice_calls). */
  retellEnabled: (process.env.RETELL_ENABLED ?? "0").trim() === "1",
  /** 1 = tras derivar_comercial (Retell) envía email al comercial y confirmación al cliente si dio email. */
  voiceLeadEmailEnabled: (process.env.VOICE_LEAD_EMAIL_ENABLED ?? "1").trim() === "1",
  /**
   * 1 = tras derivar en llamada, envía por WhatsApp al móvil del cliente (el de la llamada)
   * el contacto del comercial / ficha. No depende de WHATSAPP_PROACTIVE_OUTREACH:
   * es respuesta a quien acaba de llamar, no outreach en frío.
   */
  voiceClientWhatsappConfirm: (process.env.VOICE_CLIENT_WHATSAPP_CONFIRM ?? "1").trim() === "1",
  /** 1 = al colgar envía la transcripción completa de la llamada por email. */
  voiceTranscriptEmailEnabled: (process.env.VOICE_TRANSCRIPT_EMAIL_ENABLED ?? "1").trim() === "1",
  /** Destinatario de transcripciones de llamada (ops). */
  voiceTranscriptEmail: (
    process.env.VOICE_TRANSCRIPT_EMAIL ?? "alvaro@inmobiliariabazan.com"
  ).trim(),
  voiceBuyerAgentEmail: (process.env.VOICE_BUYER_AGENT_EMAIL ?? "miguel@inmobiliariabazan.com").trim(),
  voiceOwnerAgentEmail: (process.env.VOICE_OWNER_AGENT_EMAIL ?? "alvaro@inmobiliariabazan.com").trim(),
  /** Mapa teléfono→email: 34620555989:miguel@...,34646424563:alvaro@... */
  voiceAgentEmailByPhone: parsePhoneEmailMap(
    process.env.VOICE_AGENT_EMAIL_BY_PHONE ??
      "34620555989:miguel@inmobiliariabazan.com,34646424563:alvaro@inmobiliariabazan.com,34692682946:david@inmobiliariabazan.com,34663057430:jose@inmobiliariabazan.com",
  ),
};

export function assertOpenAiConfigured(): void {
  required("OPENAI_API_KEY");
}

export function assertWhatsAppSendConfigured(): void {
  required("WHATSAPP_TOKEN");
  required("WHATSAPP_PHONE_ID");
}

export function assertEvolutionConfigured(): void {
  required("EVOLUTION_BASE_URL");
  required("EVOLUTION_API_KEY");
}

export function assertAdminConfigured(): void {
  required("ADMIN_API_KEY");
}
