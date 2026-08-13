import { config } from "../config.js";
import { getDb } from "../db/database.js";
import { isOwnMailboxAddress } from "./classifier.js";

export function normalizeEmailAddress(raw: string): string {
  const trimmed = (raw || "").trim();
  const bracketed = trimmed.match(/<([^>]+)>/);
  return (bracketed?.[1] ?? trimmed).trim().toLowerCase();
}

function isAllowlistedOutbound(addr: string): boolean {
  const normalized = normalizeEmailAddress(addr);
  return config.emailOutboundAllowlist.some((a) => normalizeEmailAddress(a) === normalized);
}

export type OutboundEmailBlockReason =
  | "own_mailbox"
  | "rate_limit_recipient"
  | "poll_send_cap";

export function validateOutboundRecipient(to: string): OutboundEmailBlockReason | null {
  const addr = normalizeEmailAddress(to);
  if (!addr.includes("@")) return "own_mailbox";

  const self = normalizeEmailAddress(config.emailUser);
  if (self && addr === self) return "own_mailbox";

  if (isOwnMailboxAddress(addr) && !isAllowlistedOutbound(addr)) {
    return "own_mailbox";
  }

  return null;
}

export function countRecipientSendsInWindow(to: string, hours: number): number {
  const addr = normalizeEmailAddress(to);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_outbound_log
       WHERE to_address = ? AND sent_at >= datetime('now', ?)`,
    )
    .get(addr, `-${Math.max(1, hours)} hours`) as { n: number };
  return row.n;
}

/** ¿Ya enviamos algo a este destinatario en los últimos N minutos? */
export function hasRecentOutboundTo(to: string, minutes: number): boolean {
  const addr = normalizeEmailAddress(to);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_outbound_log
       WHERE to_address = ? AND sent_at >= datetime('now', ?)`,
    )
    .get(addr, `-${Math.max(1, minutes)} minutes`) as { n: number };
  return row.n > 0;
}

export function countTotalSendsInWindow(minutes: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_outbound_log
       WHERE sent_at >= datetime('now', ?)`,
    )
    .get(`-${Math.max(1, minutes)} minutes`) as { n: number };
  return row.n;
}

export function checkRateLimitBeforeSend(to: string): OutboundEmailBlockReason | null {
  if (countRecipientSendsInWindow(to, 1) >= config.emailMaxSendsPerRecipientHour) {
    return "rate_limit_recipient";
  }
  return null;
}

let pollSendCount = 0;

export function resetPollSendCount(): void {
  pollSendCount = 0;
}

export function getPollSendCount(): number {
  return pollSendCount;
}

export function checkPollSendCap(): OutboundEmailBlockReason | null {
  if (pollSendCount >= config.emailMaxSendsPerPoll) {
    return "poll_send_cap";
  }
  return null;
}

export function recordOutboundEmail(to: string, subject: string): void {
  const addr = normalizeEmailAddress(to);
  const db = getDb();
  db.prepare(
    `INSERT INTO email_outbound_log (to_address, subject_snippet) VALUES (?, ?)`,
  ).run(addr, (subject || "").slice(0, 180));
  pollSendCount += 1;
}

export function shouldAlertVolumeSpike(): boolean {
  return countTotalSendsInWindow(10) >= config.emailAlertThresholdTotal10Min;
}
