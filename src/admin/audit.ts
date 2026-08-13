import { getDb } from "../db/database.js";
import { execSync } from "node:child_process";

function readGitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return null;
  }
}

function qAll<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function qOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T {
  return getDb().prepare(sql).get(...params) as T;
}

export type OperationalAudit = {
  hours: number;
  generatedAt: string;
  commit: string | null;
  conversationsByRole: Array<{ role: string; n: number }>;
  emailsByPortal: Array<{ portal: string | null; handled: number; n: number }>;
  leadsByOrigin: Array<{ origin: string; intent: string; n: number }>;
  suspiciousLeads: Array<Record<string, unknown>>;
  suspiciousLeads48h: Array<Record<string, unknown>>;
  intentMismatches: Array<Record<string, unknown>>;
  emailsUnhandled: Array<Record<string, unknown>>;
  portalEmailsUnhandledWithContact: Array<Record<string, unknown>>;
  fallbackCounts: { total: number; last48h: number };
  fallbackExamples48h: Array<Record<string, unknown>>;
  leadQuality: Record<string, number>;
  recentLeads: Array<Record<string, unknown>>;
  whatsappPending: number;
};

export function runOperationalAudit(hours: number): OperationalAudit {
  const h = Math.min(Math.max(Math.floor(hours), 1), 8760);
  const since = `-${h} hours`;

  const suspiciousLeads = qAll(
    `SELECT datetime(created_at) AS at, COALESCE(origin, '') AS origin, intent, ref, agent_name,
            substr(summary, 1, 100) AS summary_head
     FROM lead_notifications
     WHERE created_at >= datetime('now', ?)
       AND (
         lower(summary) LIKE '%llamada no contestada%'
         OR ref = '582065'
         OR lower(summary) LIKE '%col.idealista.com%'
       )
     ORDER BY created_at DESC`,
    [since]
  );

  const fallback = qOne<{ total: number; last48h: number }>(
    `SELECT
       SUM(CASE WHEN timestamp >= datetime('now', ?) THEN 1 ELSE 0 END) AS total,
       SUM(CASE WHEN timestamp >= datetime('now', '-48 hours') THEN 1 ELSE 0 END) AS last48h
     FROM conversations
     WHERE role = 'assistant'
       AND content LIKE 'Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.%'`,
    [since]
  );

  const leadQuality = qOne<Record<string, number>>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN summary LIKE '%- Nombre: No indicado%' THEN 1 ELSE 0 END) AS sin_nombre,
            SUM(CASE WHEN summary LIKE '%- Referencia: No indicada%' THEN 1 ELSE 0 END) AS sin_ref,
            SUM(CASE WHEN summary LIKE '%Faltan datos:%' THEN 1 ELSE 0 END) AS con_faltan_datos,
            SUM(CASE WHEN origin IS NULL OR origin = '' THEN 1 ELSE 0 END) AS sin_procedencia
     FROM lead_notifications
     WHERE created_at >= datetime('now', ?)`,
    [since]
  );

  return {
    hours: h,
    generatedAt: new Date().toISOString(),
    commit: readGitCommit(),
    conversationsByRole: qAll(
      `SELECT role, COUNT(*) AS n FROM conversations
       WHERE timestamp >= datetime('now', ?) GROUP BY role`,
      [since]
    ),
    emailsByPortal: qAll(
      `SELECT portal, handled, COUNT(*) AS n FROM email_state
       WHERE processed_at >= datetime('now', ?)
       GROUP BY portal, handled ORDER BY portal, handled`,
      [since]
    ),
    leadsByOrigin: qAll(
      `SELECT COALESCE(origin, '(sin origin)') AS origin, intent, COUNT(*) AS n
       FROM lead_notifications WHERE created_at >= datetime('now', ?)
       GROUP BY origin, intent ORDER BY n DESC`,
      [since]
    ),
    suspiciousLeads,
    suspiciousLeads48h: qAll(
      `SELECT datetime(created_at) AS at, COALESCE(origin, '') AS origin, intent, ref
       FROM lead_notifications
       WHERE created_at >= datetime('now', '-48 hours')
         AND (lower(summary) LIKE '%llamada no contestada%' OR ref = '582065')
       ORDER BY created_at DESC`
    ),
    intentMismatches: qAll(
      `SELECT datetime(l.created_at) AS at, COALESCE(l.origin, '') AS origin,
              l.intent, l.ref, p.transaction_type, l.agent_name
       FROM lead_notifications l
       LEFT JOIN properties p ON p.ref = l.ref
       WHERE l.created_at >= datetime('now', ?)
         AND l.ref IS NOT NULL AND p.transaction_type IS NOT NULL
         AND (
           (lower(p.transaction_type) LIKE '%alquiler%' AND l.intent <> 'A')
           OR (lower(p.transaction_type) LIKE '%venta%' AND l.intent <> 'B')
         )
       ORDER BY l.created_at DESC`,
      [since]
    ),
    emailsUnhandled: qAll(
      `SELECT uid, datetime(processed_at) AS at, portal, handled,
              COALESCE(suppress_reason, '(sin reason)') AS reason,
              substr(subject_snippet, 1, 70) AS subj,
              substr(from_address, 1, 45) AS from_addr,
              substr(customer_phone, 1, 18) AS phone
       FROM email_state
       WHERE processed_at >= datetime('now', ?) AND handled = 0
       ORDER BY processed_at DESC LIMIT 80`,
      [since]
    ),
    portalEmailsUnhandledWithContact: qAll(
      `SELECT uid, datetime(processed_at) AS at, portal, suppress_reason,
              substr(subject_snippet, 1, 70) AS subj, customer_phone, customer_email
       FROM email_state
       WHERE processed_at >= datetime('now', ?) AND handled = 0
         AND portal IN ('idealista', 'fotocasa', 'habitatsoft')
         AND (customer_phone IS NOT NULL OR customer_email IS NOT NULL)
       ORDER BY processed_at DESC`,
      [since]
    ),
    fallbackCounts: {
      total: Number(fallback?.total ?? 0),
      last48h: Number(fallback?.last48h ?? 0),
    },
    fallbackExamples48h: qAll(
      `SELECT datetime(timestamp) AS at, phone_number, substr(content, 1, 90) AS head
       FROM conversations
       WHERE timestamp >= datetime('now', '-48 hours')
         AND role = 'assistant'
         AND content LIKE 'Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.%'
       ORDER BY timestamp DESC LIMIT 20`
    ),
    leadQuality,
    recentLeads: qAll(
      `SELECT datetime(created_at) AS at, COALESCE(origin, '') AS origin,
              intent, ref, agent_name, substr(summary, 1, 110) AS summary_head
       FROM lead_notifications
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at DESC LIMIT 25`,
      [since]
    ),
    whatsappPending: Number(
      qOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM whatsapp_pending
         WHERE processed_at IS NULL AND received_at >= datetime('now', ?)`,
        [since]
      )?.n ?? 0
    ),
  };
}
