import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { appendToSent } from "./imapClient.js";
import { EMAIL_LOGO_CID, plainTextToEmailHtml } from "./templates.js";
import {
  checkPollSendCap,
  checkRateLimitBeforeSend,
  normalizeEmailAddress,
  recordOutboundEmail,
  shouldAlertVolumeSpike,
  validateOutboundRecipient,
  type OutboundEmailBlockReason,
} from "./emailGuards.js";
import { formatEmailGuardAlert, sendOpsAlert } from "./opsAlert.js";

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.emailUser, pass: config.emailPass },
    tls: { rejectUnauthorized: false },
  });
  return transporter;
}

/** Logo 500×500 ligero para cabecera de emails (CID). */
export function resolveEmailLogoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "assets/email/logo-bazan-500.jpg"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/email/logo-bazan-500.jpg"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function alertBlockedSend(
  reason: OutboundEmailBlockReason,
  to: string,
  subject: string,
): Promise<void> {
  const msg = formatEmailGuardAlert(reason, {
    destino: normalizeEmailAddress(to),
    asunto: (subject || "").slice(0, 120),
  });
  await sendOpsAlert(`email_guard_${reason}`, msg);
}

export async function sendEmailReply(opts: {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  /** Solo alertas internas / reenvíos explícitos permitidos. */
  skipGuards?: boolean;
  /** false = sin cabecera de marca (p. ej. transcripciones). Default true. */
  includeHeaderImage?: boolean;
}): Promise<void> {
  if (!opts.skipGuards) {
    const recipientBlock = validateOutboundRecipient(opts.to);
    if (recipientBlock) {
      console.error("[email] Envío bloqueado (destinatario)", {
        to: opts.to,
        reason: recipientBlock,
        subject: opts.subject.slice(0, 80),
      });
      await alertBlockedSend(recipientBlock, opts.to, opts.subject);
      throw new Error(`Outbound email blocked: ${recipientBlock}`);
    }

    const rateBlock = checkRateLimitBeforeSend(opts.to);
    if (rateBlock) {
      console.error("[email] Envío bloqueado (rate limit destinatario)", {
        to: opts.to,
        subject: opts.subject.slice(0, 80),
      });
      await alertBlockedSend(rateBlock, opts.to, opts.subject);
      throw new Error(`Outbound email blocked: ${rateBlock}`);
    }

    const pollBlock = checkPollSendCap();
    if (pollBlock) {
      console.error("[email] Envío bloqueado (límite por poll)", {
        to: opts.to,
        subject: opts.subject.slice(0, 80),
      });
      await alertBlockedSend(pollBlock, opts.to, opts.subject);
      throw new Error(`Outbound email blocked: ${pollBlock}`);
    }
  }

  const t = getTransporter();
  const includeHeader = opts.includeHeaderImage !== false;
  const logoPath = includeHeader && !opts.html ? resolveEmailLogoPath() : null;

  const html =
    opts.html ??
    plainTextToEmailHtml(opts.text, {
      title: opts.subject,
      includeHeaderImage: includeHeader && Boolean(logoPath),
    });

  const message: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    text: string;
    html: string;
    inReplyTo?: string;
    references?: string;
    attachments?: Array<{
      filename: string;
      path: string;
      cid: string;
      contentDisposition: "inline";
    }>;
  } = {
    from: `"${config.emailFromName}" <${config.emailUser}>`,
    to: opts.to,
    ...(opts.cc ? { cc: opts.cc } : {}),
    subject: opts.subject,
    text: opts.text,
    html,
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo, references: opts.references ?? opts.inReplyTo } : {}),
  };

  if (logoPath) {
    message.attachments = [
      {
        filename: "logo-bazan-500.jpg",
        path: logoPath,
        cid: EMAIL_LOGO_CID,
        contentDisposition: "inline",
      },
    ];
  }

  await t.sendMail(message);

  // Registrar siempre en el panel (también leads a comerciales con skipGuards).
  recordOutboundEmail(opts.to, opts.subject);

  if (!opts.skipGuards) {
    if (shouldAlertVolumeSpike()) {
      const msg = formatEmailGuardAlert("volumen_anómalo", {
        umbral: config.emailAlertThresholdTotal10Min,
      });
      await sendOpsAlert("email_volume_spike", msg);
    }
  }

  // Guardar en "Enviados" vía IMAP (no lo hace SMTP por sí solo)
  try {
    const raw = await new MailComposer({
      ...message,
      date: new Date(),
    })
      .compile()
      .build();
    await appendToSent(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  } catch (e) {
    console.warn("[email] No se pudo guardar en Enviados (IMAP APPEND):", e);
  }
}
