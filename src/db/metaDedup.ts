import { getDb } from "./database.js";

/**
 * Intenta reservar esta clave de deduplicación. Devuelve true si es nuevo (procesar).
 */
export function tryClaimMetaDedup(dedupKey: string): boolean {
  const db = getDb();
  const result = db.prepare(`INSERT OR IGNORE INTO meta_webhook_dedup (dedup_key) VALUES (?)`).run(dedupKey);
  return result.changes > 0;
}
