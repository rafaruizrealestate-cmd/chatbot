import { config } from "../config.js";
import { getDb } from "../db/database.js";
import { sendOutboundWhatsAppText } from "../whatsapp/outbound.js";
import { countTotalSendsInWindow } from "./emailGuards.js";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

const ALERT_COOLDOWN_MINUTES = 30;

let alertTransporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null;

function getAlertTransporter() {
  if (alertTransporter) return alertTransporter;
  alertTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.emailUser, pass: config.emailPass },
    tls: { rejectUnauthorized: false },
  });
  return alertTransporter;
}

function wasAlertSentRecently(alertKey: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM ops_alerts_sent
       WHERE alert_key = ? AND sent_at >= datetime('now', ?)
       LIMIT 1`,
    )
    .get(alertKey, `-${ALERT_COOLDOWN_MINUTES} minutes`) as Record<string, unknown> | undefined;
  return row !== undefined;
}

function markAlertSent(alertKey: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO ops_alerts_sent (alert_key, sent_at) VALUES (?, datetime('now'))
     ON CONFLICT(alert_key) DO UPDATE SET sent_at = datetime('now')`,
  ).run(alertKey);
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const to = config.opsAlertEmail.trim();
  if (!to || !config.emailUser || !config.emailPass) return;
  const t = getAlertTransporter();
  await t.sendMail({
    from: `"${config.opsAlertPrefix} - Alertas" <${config.emailUser}>`,
    to,
    subject,
    text: body,
  });
}

/** Alerta operativa: WhatsApp primero; email a Álvaro si falla. Dedup 30 min por clave. */
export async function sendOpsAlert(alertKey: string, message: string): Promise<void> {
  if (wasAlertSentRecently(alertKey)) {
    console.log("[ops] Alerta omitida (cooldown)", { alertKey });
    return;
  }

  const wa = config.opsAlertWhatsapp.trim();
  const subject = `[${config.opsAlertPrefix}] Alerta email: ${alertKey}`;

  if (wa) {
    try {
      await sendOutboundWhatsAppText(wa, message);
      markAlertSent(alertKey);
      console.log("[ops] Alerta enviada por WhatsApp", { alertKey, to: wa });
      return;
    } catch (e) {
      console.error("[ops] Fallo alerta WhatsApp; intentando email", { alertKey, error: e });
    }
  }

  try {
    await sendAlertEmail(subject, message);
    markAlertSent(alertKey);
    console.log("[ops] Alerta enviada por email", { alertKey, to: config.opsAlertEmail });
  } catch (e) {
    console.error("[ops] Fallo alerta email", { alertKey, error: e });
  }
}

export function formatEmailGuardAlert(
  reason: string,
  details: Record<string, string | number | undefined>,
): string {
  const lines = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  const recent = countTotalSendsInWindow(10);
  return [
    `⚠️ ${config.opsAlertPrefix} — alerta de email`,
    "",
    `Motivo: ${reason}`,
    ...lines,
    `Envíos últimos 10 min: ${recent}`,
    "",
    "Revisa /var/log/email-poll.log en el VPS si persiste.",
  ].join("\n");
}
