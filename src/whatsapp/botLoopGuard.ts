import { config } from "../config.js";
import { getDb } from "../db/database.js";
import { countMessagesInWindow, getRecentMessages } from "../db/conversations.js";
import { recordAiAction } from "../panel/aiActions.js";

/** Números que ya sabemos que son bots / bucles (bloqueo permanente). */
const PERMANENT_BOT_PHONES = new Set([
  "34627159774", // Firinde / Taller Motryx — bucle ago 2026
]);

/**
 * Despedida SOLO la primera vez en bucles "dudosos" (cadencia alta).
 * En bots claros: silencio total (una despedida reactivaría al otro bot).
 */
const MUTE_FAREWELL =
  "Entendido. Cierro esta conversación por ahora. Si eres una persona y buscas inmueble en Málaga, escribe más tarde o llama al 951 870 058.";

/** Señales típicas de otro bot / automatismo. */
const OTHER_BOT_RE =
  /\b(?:taller\s+mec[aá]nico|citas?\s+en\s+el\s+taller|solo\s+(?:gestionamos|atendemos|ofrecemos)\s+(?:temas?\s+de\s+)?(?:taller|coches|veh[ií]culos)|no\s+gestionamos\s+inmuebles|aqu[ií]\s+solo\s+(?:gestionamos|atendemos)\s+(?:coches|taller)|soy\s+(?:un\s+)?(?:asistente\s+virtual|bot|ia)\b|como\s+(?:asistente\s+)?ia\b|automated\s+(?:message|response)|this\s+is\s+an\s+automated|no\s+soy\s+(?:un\s+)?humano)\b/i;

/** Misma pregunta del bot / mismo texto del otro lado: 3 = corte. */
export const REPEAT_LIMIT = 3;

export type BotLoopHit = {
  reason: string;
  /** Si es null → silencio total (recomendado frente a otro bot). */
  farewell: string | null;
};

function digits(phone: string): string {
  return phone.replace(/\D+/g, "");
}

/** Números exentos del anti-bucle (internos, pruebas). Nunca se silencian. */
export function isNeverMutePhone(phone: string): boolean {
  return config.whatsappNeverMutePhones.has(digits(phone));
}

/** Huella estable para comparar “misma pregunta”. */
export function fingerprint(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Cuántas veces seguidas aparece el mismo fingerprint al final de la lista. */
export function trailingRepeatStreak(texts: string[]): number {
  const fps = texts.map(fingerprint).filter((f) => f.length >= 12);
  if (fps.length === 0) return 0;
  const last = fps[fps.length - 1]!;
  let n = 0;
  for (let i = fps.length - 1; i >= 0; i--) {
    if (fps[i] === last) n++;
    else break;
  }
  return n;
}

/** Cuántas veces aparece el fingerprint más frecuente en los últimos N textos. */
export function maxFingerprintCount(texts: string[], lookback = 10): number {
  const fps = texts
    .slice(-lookback)
    .map(fingerprint)
    .filter((f) => f.length >= 12);
  if (fps.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const f of fps) counts.set(f, (counts.get(f) ?? 0) + 1);
  return Math.max(...counts.values());
}

export function isPermanentlyBlockedBot(phone: string): boolean {
  return PERMANENT_BOT_PHONES.has(digits(phone));
}

export function looksLikeOtherBotMessage(text: string): boolean {
  return OTHER_BOT_RE.test(text);
}

export function ensureMutedContactsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS muted_contacts (
      phone_number TEXT PRIMARY KEY,
      reason TEXT,
      muted_until DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function isContactMuted(phone: string): boolean {
  ensureMutedContactsTable();
  const d = digits(phone);
  if (!d) return false;
  if (isNeverMutePhone(d)) return false;
  if (PERMANENT_BOT_PHONES.has(d)) return true;
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM muted_contacts
       WHERE phone_number = ?
         AND datetime(muted_until) > datetime('now')`
    )
    .get(d) as { ok: number } | undefined;
  return Boolean(row);
}

/** Silencia el número (por defecto 7 días). */
export function muteContact(phone: string, reason: string, hours = 168): void {
  ensureMutedContactsTable();
  const d = digits(phone);
  if (!d) return;
  if (isNeverMutePhone(d)) {
    console.log("[whatsapp] Número en lista blanca; no se silencia", {
      phoneTail: d.slice(-4),
      reason,
    });
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO muted_contacts (phone_number, reason, muted_until)
       VALUES (?, ?, datetime('now', ?))
       ON CONFLICT(phone_number) DO UPDATE SET
         reason = excluded.reason,
         muted_until = excluded.muted_until`
    )
    .run(d, reason.slice(0, 200), `+${Math.max(1, hours)} hours`);
}

/**
 * Umbrales de cadencia. Muy por encima de cualquier conversación humana:
 * solo saltan en un ping-pong automático real (el bucle Firinde iba a ~12 msg/min).
 */
/** Silencio por cadencia: corto, para que un cliente real no quede fuera días. */
const RATE_MUTE_HOURS = 2;

const RATE_LIMITS: Array<{ minutes: number; max: number; label: string }> = [
  { minutes: 5, max: 40, label: "5m" },
  { minutes: 60, max: 150, label: "60m" },
  { minutes: 60 * 24, max: 500, label: "24h" },
];

/**
 * Capas anti-bucle (evaluar ANTES de OpenAI):
 * 1) blacklist permanente
 * 2) cadencia (msgs por ventana) — solo bucles evidentes
 *
 * El modo "full" añade detección de repetición (misma pregunta/mensaje ×3) y
 * de contenido de otro bot. Está desactivado por defecto: daba falsos positivos
 * con clientes reales que repiten "hola".
 */
export function detectBotLoop(phone: string, latestUserText: string): BotLoopHit | null {
  const d = digits(phone);
  if (!d) return null;
  if (isNeverMutePhone(d)) return null;

  if (PERMANENT_BOT_PHONES.has(d)) {
    return { reason: "permanent_bot_phone", farewell: null };
  }

  if (config.whatsappBotLoopGuard === "full") {
    const hit = detectRepetitionLoop(phone, latestUserText);
    if (hit) return hit;
  }

  for (const { minutes, max, label } of RATE_LIMITS) {
    const n = countMessagesInWindow(phone, minutes);
    if (n >= max) {
      return { reason: `rate_${label}_${n}`, farewell: MUTE_FAREWELL };
    }
  }

  return null;
}

/** Capa de repetición (solo modo "full"): misma pregunta ×3 o señales de otro bot. */
function detectRepetitionLoop(phone: string, latestUserText: string): BotLoopHit | null {
  const recent = getRecentMessages(phone, 30);
  const userMsgs = [
    ...recent.filter((m) => m.role === "user").map((m) => m.content),
    latestUserText,
  ];
  const asstMsgs = recent.filter((m) => m.role === "assistant").map((m) => m.content);

  const asstMax = maxFingerprintCount(asstMsgs, 12);
  const asstStreak = trailingRepeatStreak(asstMsgs);
  if (asstMax >= REPEAT_LIMIT || asstStreak >= REPEAT_LIMIT) {
    return { reason: `same_assistant_question_x${Math.max(asstMax, asstStreak)}`, farewell: null };
  }
  if (
    (asstMax >= REPEAT_LIMIT - 1 || asstStreak >= REPEAT_LIMIT - 1) &&
    (looksLikeOtherBotMessage(latestUserText) ||
      trailingRepeatStreak(userMsgs) >= 2 ||
      maxFingerprintCount(userMsgs, 8) >= 2)
  ) {
    return { reason: "same_assistant_question_about_to_x3", farewell: null };
  }

  if (
    trailingRepeatStreak(userMsgs) >= REPEAT_LIMIT ||
    maxFingerprintCount(userMsgs, 10) >= REPEAT_LIMIT
  ) {
    return { reason: "same_user_message_x3", farewell: null };
  }

  const botishUserCount = userMsgs.filter((m) => looksLikeOtherBotMessage(m)).length;
  if (looksLikeOtherBotMessage(latestUserText) && botishUserCount >= 2) {
    return { reason: "other_bot_content", farewell: null };
  }

  return null;
}

/** Si hay hit: mutea. Despedida solo si el hit lo pide (nunca en bots claros). */
export function applyBotLoopGuard(
  phone: string,
  latestUserText: string
): { blocked: boolean; farewell: string | null; reason?: string } {
  if (config.whatsappBotLoopGuard === "off") {
    return { blocked: false, farewell: null };
  }
  if (isContactMuted(phone)) {
    return { blocked: true, farewell: null, reason: "already_muted" };
  }
  const hit = detectBotLoop(phone, latestUserText);
  if (!hit) return { blocked: false, farewell: null };

  // Cadencia: silencio corto (se recupera solo). Bot conocido: silencio largo.
  const hours = hit.reason.startsWith("rate_") ? RATE_MUTE_HOURS : 168;
  muteContact(phone, hit.reason, hours);
  recordAiAction({
    source: "whatsapp",
    channelId: digits(phone),
    phone,
    tool: "silenciar_contacto",
    input: { motivo: hit.reason, horas: hours },
    output: { despedida: Boolean(hit.farewell) },
  });
  console.warn("[whatsapp] Conversación silenciada (anti-bucle)", {
    phoneTail: digits(phone).slice(-4),
    reason: hit.reason,
    farewell: Boolean(hit.farewell),
  });

  // Aviso ops (WA/email) — fire-and-forget; no bloquear el corte.
  void notifyOpsBotLoop(phone, hit.reason);

  return { blocked: true, farewell: hit.farewell, reason: hit.reason };
}

async function notifyOpsBotLoop(phone: string, reason: string): Promise<void> {
  try {
    const { sendOpsAlert } = await import("../email/opsAlert.js");
    const d = digits(phone);
    const in10m = countMessagesInWindow(phone, 10);
    const in60m = countMessagesInWindow(phone, 60);
    const msg = [
      "⚠️ Alerta WhatsApp — posible bucle/bot",
      "",
      `Teléfono: …${d.slice(-4)} (${d})`,
      `Motivo: ${reason}`,
      `Msgs últimos 10 min: ${in10m}`,
      `Msgs última hora: ${in60m}`,
      "",
      "El número ha sido silenciado automáticamente.",
      "Revisa muted_contacts en la BD si hace falta desbloquear.",
    ].join("\n");
    // Clave por teléfono para no spamear; cooldown 30 min en sendOpsAlert.
    await sendOpsAlert(`wa_bot_loop_${d}`, msg);
  } catch (e) {
    console.error("[whatsapp] Fallo al enviar alerta ops anti-bucle", e);
  }
}
