import { getDb } from "./database.js";

export type EmailStateRow = {
  uid: number;
  messageId?: string | null;
  portal?: string | null;
  fromAddress?: string | null;
  subjectSnippet?: string | null;
  bodySnippet?: string | null;
  suppressReason?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  handled?: boolean;
};

export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^<|>$/g, "").toLowerCase();
}

export function getEmailStateByUid(uid: number): EmailStateRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT uid, message_id AS messageId, portal, from_address AS fromAddress,
              subject_snippet AS subjectSnippet, body_snippet AS bodySnippet,
              suppress_reason AS suppressReason, customer_email AS customerEmail,
              customer_phone AS customerPhone, handled
       FROM email_state WHERE uid = ?`,
    )
    .get(uid) as
    | {
        uid: number;
        messageId: string | null;
        portal: string | null;
        fromAddress: string | null;
        subjectSnippet: string | null;
        bodySnippet: string | null;
        suppressReason: string | null;
        customerEmail: string | null;
        customerPhone: string | null;
        handled: number;
      }
    | undefined;

  if (!row) return null;
  return {
    uid: row.uid,
    messageId: row.messageId,
    portal: row.portal,
    fromAddress: row.fromAddress,
    subjectSnippet: row.subjectSnippet,
    bodySnippet: row.bodySnippet,
    suppressReason: row.suppressReason,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    handled: row.handled === 1,
  };
}

/** True si el UID en BD corresponde al mismo mensaje IMAP (por Message-ID). */
export function isSameStoredEmail(
  stored: EmailStateRow | null,
  messageId: string | null,
): boolean {
  if (!stored) return false;
  const a = normalizeMessageId(stored.messageId);
  const b = normalizeMessageId(messageId);
  if (a && b) return a === b;
  return false;
}

export function isEmailProcessed(uid: number): boolean {
  return getEmailStateByUid(uid) !== null;
}

export function insertEmailState(row: EmailStateRow): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO email_state
       (uid, message_id, portal, from_address, subject_snippet, body_snippet, suppress_reason,
        customer_email, customer_phone, handled, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(uid) DO UPDATE SET
       message_id = excluded.message_id,
       portal = excluded.portal,
       from_address = excluded.from_address,
       subject_snippet = excluded.subject_snippet,
       body_snippet = excluded.body_snippet,
       suppress_reason = excluded.suppress_reason,
       customer_email = excluded.customer_email,
       customer_phone = excluded.customer_phone,
       handled = excluded.handled,
       processed_at = CURRENT_TIMESTAMP`,
  ).run(
    row.uid,
    row.messageId ?? null,
    row.portal ?? null,
    row.fromAddress ?? null,
    row.subjectSnippet ?? null,
    row.bodySnippet ?? null,
    row.suppressReason ?? null,
    row.customerEmail ?? null,
    row.customerPhone ?? null,
    row.handled ? 1 : 0,
  );
}

export function findRecentEmailByCustomer(
  customerEmail: string,
  hours: number,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM email_state
       WHERE customer_email = ? AND handled = 1
         AND processed_at >= datetime('now', ?)
       LIMIT 1`,
    )
    .get(customerEmail, `-${Math.max(1, hours)} hours`) as Record<string, unknown> | undefined;
  return row !== undefined;
}
