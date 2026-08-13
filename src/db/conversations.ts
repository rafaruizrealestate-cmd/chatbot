import { getDb } from "./database.js";
import { config } from "../config.js";

export type Role = "user" | "assistant";

export function appendMessage(phoneNumber: string, role: Role, content: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO conversations (phone_number, role, content) VALUES (?, ?, ?)`
  ).run(phoneNumber, role, content);
}

export function getRecentMessages(phoneNumber: string, limit: number): Array<{ role: Role; content: string }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM conversations
       WHERE phone_number = ?
 AND datetime(timestamp) > datetime('now', ?)
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(phoneNumber, `-${config.conversationTtlHours} hours`, limit) as Array<{ role: string; content: string }>;
  return rows.reverse().map((r) => ({ role: r.role as Role, content: r.content }));
}

export function getMessagesForOpenAI(
  phoneNumber: string
): Array<{ role: "user" | "assistant"; content: string }> {
  return getRecentMessages(phoneNumber, config.maxConversationHistory);
}

/** Mensajes (user+assistant) de este teléfono en los últimos `minutes` minutos. */
export function countMessagesInWindow(phoneNumber: string, minutes: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM conversations
       WHERE phone_number = ?
         AND datetime(timestamp) > datetime('now', ?)`
    )
    .get(phoneNumber, `-${Math.max(1, minutes)} minutes`) as { n: number };
  return Number(row?.n ?? 0);
}
