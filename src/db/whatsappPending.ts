import { getDb } from "./database.js";

export type WhatsappPendingRow = {
  id: number;
  conversation_key: string;
  provider: string;
  provider_instance: string | null;
  text: string;
  received_at: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
};

export function enqueueWhatsappPending(opts: {
  conversationKey: string;
  provider: "evolution" | "meta" | "unknown";
  providerInstance?: string;
  text: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO whatsapp_pending (conversation_key, provider, provider_instance, text)
     VALUES (?, ?, ?, ?)`
  ).run(opts.conversationKey, opts.provider, opts.providerInstance ?? null, opts.text);
}

export function listUnprocessedWhatsappPending(limit = 200): WhatsappPendingRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, conversation_key, provider, provider_instance, text, received_at, processed_at, attempts, last_error
       FROM whatsapp_pending
       WHERE processed_at IS NULL
       ORDER BY datetime(received_at) ASC
       LIMIT ?`
    )
    .all(limit) as WhatsappPendingRow[];
  return rows;
}

export function markWhatsappPendingProcessed(id: number): void {
  const db = getDb();
  db.prepare(`UPDATE whatsapp_pending SET processed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

export function markWhatsappPendingFailed(id: number, error: unknown): void {
  const db = getDb();
  const msg = (() => {
    try {
      return typeof error === "string" ? error : JSON.stringify(error);
    } catch {
      return String(error);
    }
  })();
  db.prepare(
    `UPDATE whatsapp_pending
     SET attempts = attempts + 1, last_error = ?
     WHERE id = ?`
  ).run(msg.slice(0, 2000), id);
}

