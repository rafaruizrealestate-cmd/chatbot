import { getDb } from "../db/database.js";

/**
 * Comprueba si este lead concreto ya se gestionó (mismo teléfono + ref cuando se conoce la ref).
 */
export function isAlreadyHandled(opts: {
  customerPhone: string | null;
  customerEmail: string | null;
  propertyRef: string | null;
  hoursWindow?: number;
}): boolean {
  const hours = opts.hoursWindow ?? 48;
  const db = getDb();
  const since = `-${hours} hours`;
  const ref = opts.propertyRef?.trim() || null;

  if (opts.customerPhone && ref) {
    const byPhoneRef = db
      .prepare(
        `SELECT 1 FROM lead_notifications
         WHERE customer_phone = ?
           AND ref = ?
           AND created_at >= datetime('now', ?)
         LIMIT 1`
      )
      .get(opts.customerPhone, ref, since) as Record<string, unknown> | undefined;
    if (byPhoneRef) return true;
  } else if (opts.customerPhone && !ref) {
    const byPhoneNoRef = db
      .prepare(
        `SELECT 1 FROM lead_notifications
         WHERE customer_phone = ?
           AND (ref IS NULL OR ref = '')
           AND created_at >= datetime('now', ?)
         LIMIT 1`
      )
      .get(opts.customerPhone, since) as Record<string, unknown> | undefined;
    if (byPhoneNoRef) return true;
  }

  if (opts.customerEmail && ref) {
    const refInSubject = `%ref: ${ref},%`;
    const refInSubjectAlt = `%referencia ${ref}%`;

    const byEmailRef = db
      .prepare(
        `SELECT 1 FROM email_state
         WHERE customer_email = ? AND handled = 1
           AND processed_at >= datetime('now', ?)
           AND (subject_snippet LIKE ? OR subject_snippet LIKE ?)
         LIMIT 1`
      )
      .get(opts.customerEmail, since, refInSubject, refInSubjectAlt) as
      | Record<string, unknown>
      | undefined;
    if (byEmailRef) return true;

    const profileByEmailRef = db
      .prepare(
        `SELECT 1 FROM lead_profiles
         WHERE email = ? AND ref = ?
           AND updated_at >= datetime('now', ?)
         LIMIT 1`
      )
      .get(opts.customerEmail, ref, since) as Record<string, unknown> | undefined;
    if (profileByEmailRef) return true;
  } else if (opts.customerEmail && !ref) {
    const byEmailNoRef = db
      .prepare(
        `SELECT 1 FROM email_state
         WHERE customer_email = ? AND handled = 1
           AND processed_at >= datetime('now', ?)
           AND subject_snippet NOT LIKE '%ref: %'
           AND subject_snippet NOT LIKE '%referencia %'
         LIMIT 1`
      )
      .get(opts.customerEmail, since) as Record<string, unknown> | undefined;
    if (byEmailNoRef) return true;
  }

  return false;
}
