import { getDb } from "./database.js";
import {
  buildDesenlaceSteps,
  resolveClientChannel,
  type DesenlaceRow,
  type LeadDeliveryChannels,
} from "../leads/delivery.js";
import { resolveAgentEmailForVoice } from "../voice/voiceLeadEmail.js";

export type LeadNotificationRow = {
  customerPhone: string;
  agentPhone: string;
  agentName: string;
  ref: string | null;
  intent: string | null;
  origin?: string | null;
  summary: string;
  callId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
};

export type LeadDeliveryPatch = {
  agentWa?: boolean | null;
  agentEmail?: boolean | null;
  clientWa?: boolean | null;
  clientEmail?: boolean | null;
  clientChannel?: "whatsapp" | "email" | "none" | null;
  notes?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
};

function boolToSql(v: boolean | null | undefined): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

export function getLeadProfileName(customerPhone: string): string | null {
  const p = getLeadProfile(customerPhone);
  return p?.name ?? null;
}

export type LeadProfileView = {
  name: string | null;
  email: string | null;
  ref: string | null;
  intentType: string | null;
};

export function getLeadProfile(customerPhone: string): LeadProfileView | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT name, email, ref, intent_type AS intentType FROM lead_profiles WHERE customer_phone = ?`,
    )
    .get(customerPhone) as LeadProfileView | undefined;
  return row ?? null;
}

/** Evita re-avisar al agente por el mismo contacto (y misma ref si se conoce). */
export function hasRecentLeadNotification(
  customerPhone: string,
  hours: number,
  ref?: string | null,
): boolean {
  const db = getDb();
  const h = Math.max(1, hours);
  if (ref) {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS c FROM lead_notifications
        WHERE customer_phone = ?
          AND ref = ?
          AND created_at >= datetime('now', ?)
        `,
      )
      .get(customerPhone, ref, `-${h} hours`) as { c: number };
    return row.c > 0;
  }
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS c FROM lead_notifications
      WHERE customer_phone = ?
        AND created_at >= datetime('now', ?)
      `,
    )
    .get(customerPhone, `-${h} hours`) as { c: number };
  return row.c > 0;
}

/** Inserta el lead y devuelve su id. */
export function insertLeadNotification(row: LeadNotificationRow): number {
  const db = getDb();
  const info = db
    .prepare(
      `
    INSERT INTO lead_notifications (
      customer_phone, agent_phone, agent_name, ref, intent, origin, summary,
      call_id, customer_name, customer_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      row.customerPhone,
      row.agentPhone,
      row.agentName,
      row.ref,
      row.intent,
      row.origin ?? null,
      row.summary,
      row.callId ?? null,
      row.customerName ?? null,
      row.customerEmail ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function updateLeadNotificationDelivery(
  id: number,
  patch: LeadDeliveryPatch,
): void {
  const db = getDb();
  let channel: string | null = null;
  if (patch.clientChannel != null) {
    channel = patch.clientChannel;
  } else if (patch.clientWa === true) {
    channel = "whatsapp";
  } else if (patch.clientEmail === true) {
    channel = "email";
  }
  // Si solo falla un canal parcial, no pises client_channel con "none".

  db.prepare(
    `
    UPDATE lead_notifications SET
      agent_wa = COALESCE(?, agent_wa),
      agent_email = COALESCE(?, agent_email),
      client_wa = COALESCE(?, client_wa),
      client_email = COALESCE(?, client_email),
      client_channel = COALESCE(?, client_channel),
      notes = COALESCE(?, notes),
      customer_name = COALESCE(?, customer_name),
      customer_email = COALESCE(?, customer_email)
    WHERE id = ?
    `,
  ).run(
    boolToSql(patch.agentWa),
    boolToSql(patch.agentEmail),
    boolToSql(patch.clientWa),
    boolToSql(patch.clientEmail),
    channel,
    patch.notes ?? null,
    patch.customerName ?? null,
    patch.customerEmail ?? null,
    id,
  );
}

export function applyDeliveryChannels(
  id: number,
  channels: LeadDeliveryChannels,
  extra?: { notes?: string | null; customerName?: string | null; customerEmail?: string | null },
): void {
  updateLeadNotificationDelivery(id, {
    agentWa: channels.agent.whatsapp,
    agentEmail: channels.agent.email,
    clientWa: channels.client.whatsapp,
    clientEmail: channels.client.email,
    clientChannel: resolveClientChannel(channels.client),
    notes: extra?.notes ?? null,
    customerName: extra?.customerName ?? null,
    customerEmail: extra?.customerEmail ?? null,
  });
}

export type LeadNotificationDbRow = {
  id: number;
  created_at: string;
  customer_phone: string;
  agent_phone: string;
  agent_name: string;
  ref: string | null;
  intent: string | null;
  origin: string | null;
  summary: string;
  call_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  agent_wa: number | null;
  agent_email: number | null;
  client_wa: number | null;
  client_email: number | null;
  client_channel: string | null;
  notes: string | null;
  nombre?: string | null;
  email?: string | null;
};

export function mapLeadToDesenlace(row: LeadNotificationDbRow): DesenlaceRow {
  const { steps, parcial } = buildDesenlaceSteps(row);
  const agentPhone = (row.agent_phone || "").replace(/\D+/g, "");
  const agentEmailTo = agentPhone
    ? resolveAgentEmailForVoice({ name: row.agent_name, phone: agentPhone })
    : null;
  const customerDigits = (row.customer_phone || "").replace(/\D+/g, "");
  const clientReply = customerDigits.length >= 8 ? latestAssistantReply(customerDigits) : null;
  const summary = row.summary?.trim() || null;
  const agentMessage =
    summary && /^tienes un nuevo lead/i.test(summary) ? summary : summary;

  return {
    id: row.id,
    created_at: row.created_at,
    origin: row.origin,
    intent: row.intent,
    ref: row.ref,
    summary,
    call_id: row.call_id,
    customer_phone: row.customer_phone,
    customer_name: row.customer_name || row.nombre || null,
    customer_email: row.customer_email || row.email || null,
    agent_name: row.agent_name,
    agent_phone: row.agent_phone,
    agent_email_to: agentEmailTo,
    agent_wa: row.agent_wa,
    agent_email: row.agent_email,
    client_wa: row.client_wa,
    client_email: row.client_email,
    client_channel: row.client_channel,
    notes: row.notes,
    agent_message: agentMessage,
    client_reply: clientReply,
    parcial,
    steps,
  };
}

function latestAssistantReply(phoneDigits: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT content FROM conversations
      WHERE replace(replace(phone_number, '+', ''), ' ', '') LIKE ?
        AND role = 'assistant'
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
      `,
    )
    .get(`%${phoneDigits.slice(-9)}`) as { content: string } | undefined;
  return row?.content?.trim() || null;
}

/** Marca envío al cliente en el lead más reciente del teléfono o email. */
export function markLatestLeadClientDelivery(
  customerKey: string | null | undefined,
  patch: { clientWa?: boolean; clientEmail?: boolean; notes?: string | null },
): void {
  const raw = (customerKey ?? "").trim();
  if (!raw) return;
  const db = getDb();
  const digits = raw.replace(/\D+/g, "");
  let row: { id: number } | undefined;
  if (digits.length >= 8) {
    row = db
      .prepare(
        `
        SELECT id FROM lead_notifications
        WHERE replace(replace(customer_phone, '+', ''), ' ', '') LIKE ?
        ORDER BY id DESC LIMIT 1
        `,
      )
      .get(`%${digits.slice(-9)}`) as { id: number } | undefined;
  }
  if (!row && raw.includes("@")) {
    row = db
      .prepare(
        `
        SELECT id FROM lead_notifications
        WHERE lower(customer_email) = lower(?)
           OR lower(customer_phone) LIKE ?
        ORDER BY id DESC LIMIT 1
        `,
      )
      .get(raw, `%${raw.toLowerCase()}%`) as { id: number } | undefined;
  }
  if (!row) return;
  updateLeadNotificationDelivery(row.id, {
    clientWa: patch.clientWa,
    clientEmail: patch.clientEmail,
    notes: patch.notes ?? null,
  });
}

export function listDesenlaces(limit: number, offset: number): DesenlaceRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT l.*,
             (SELECT name FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS nombre,
             (SELECT email FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS email
      FROM lead_notifications l
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(limit, offset) as LeadNotificationDbRow[];
  return rows.map(mapLeadToDesenlace);
}

export function getDesenlaceByCallId(callId: string): DesenlaceRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT l.*,
             (SELECT name FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS nombre,
             (SELECT email FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS email
      FROM lead_notifications l
      WHERE l.call_id = ?
      ORDER BY l.id DESC
      LIMIT 1
      `,
    )
    .get(callId) as LeadNotificationDbRow | undefined;
  if (row) return mapLeadToDesenlace(row);

  // Fallback histórico: lead por teléfono del caller en ventana de la llamada.
  const call = db
    .prepare(`SELECT caller, started_at, ended_at FROM voice_calls WHERE id = ?`)
    .get(callId) as
    | { caller: string | null; started_at: string; ended_at: string | null }
    | undefined;
  if (!call?.caller) return null;
  const phone = call.caller.replace(/\D+/g, "");
  if (phone.length < 8) return null;
  const nearby = db
    .prepare(
      `
      SELECT l.*,
             (SELECT name FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS nombre,
             (SELECT email FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS email
      FROM lead_notifications l
      WHERE replace(replace(l.customer_phone, '+', ''), ' ', '') LIKE ?
        AND l.created_at >= datetime(?, '-15 minutes')
        AND l.created_at <= datetime(COALESCE(?, ?), '+30 minutes')
      ORDER BY l.id DESC
      LIMIT 1
      `,
    )
    .get(
      `%${phone.slice(-9)}`,
      call.started_at,
      call.ended_at,
      call.started_at,
    ) as LeadNotificationDbRow | undefined;
  return nearby ? mapLeadToDesenlace(nearby) : null;
}

export type LeadProfilePatch = {
  customerPhone: string;
  name?: string | null;
  email?: string | null;
  intentType?: string | null;
  ref?: string | null;
  budget?: number | null;
  monthlyIncome?: number | null;
  hasGuarantor?: boolean | null;
  wantsVisit?: boolean | null;
  extraNotes?: string | null;
};

export const MISSED_CALL_PENDING_TAG = "missed_call_pending";

export function isMissedCallPending(customerPhone: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT extra_notes FROM lead_profiles WHERE customer_phone = ?`)
    .get(customerPhone) as { extra_notes?: string | null } | undefined;
  return (row?.extra_notes ?? "").includes(MISSED_CALL_PENDING_TAG);
}

export function markMissedCallPending(customerPhone: string, origin: string): void {
  upsertLeadProfile({
    customerPhone,
    extraNotes: `${MISSED_CALL_PENDING_TAG}|origen:${origin}`,
  });
}

export function getMissedCallLeadOrigin(customerPhone: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT extra_notes FROM lead_profiles WHERE customer_phone = ?`)
    .get(customerPhone) as { extra_notes?: string | null } | undefined;
  const m = (row?.extra_notes ?? "").match(/\|origen:([^\s|]+)/);
  return m?.[1]?.trim() || null;
}

export function clearLeadProfileRef(customerPhone: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE lead_profiles SET ref = NULL, updated_at = CURRENT_TIMESTAMP WHERE customer_phone = ?`,
  ).run(customerPhone);
}

export function clearMissedCallPending(customerPhone: string): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT extra_notes FROM lead_profiles WHERE customer_phone = ?`)
    .get(customerPhone) as { extra_notes?: string | null } | undefined;
  const notes = (row?.extra_notes ?? "")
    .replace(MISSED_CALL_PENDING_TAG, "")
    .replace(/\|origen:[^\s|]+/g, "")
    .trim();
  db.prepare(
    `UPDATE lead_profiles SET extra_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_phone = ?`,
  ).run(notes || null, customerPhone);
}

export function upsertLeadProfile(patch: LeadProfilePatch): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO lead_profiles (
      customer_phone, name, email, intent_type, ref, budget, monthly_income,
      has_guarantor, wants_visit, extra_notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(customer_phone) DO UPDATE SET
      name = COALESCE(excluded.name, lead_profiles.name),
      email = COALESCE(excluded.email, lead_profiles.email),
      intent_type = COALESCE(excluded.intent_type, lead_profiles.intent_type),
      ref = COALESCE(excluded.ref, lead_profiles.ref),
      budget = COALESCE(excluded.budget, lead_profiles.budget),
      monthly_income = COALESCE(excluded.monthly_income, lead_profiles.monthly_income),
      has_guarantor = COALESCE(excluded.has_guarantor, lead_profiles.has_guarantor),
      wants_visit = COALESCE(excluded.wants_visit, lead_profiles.wants_visit),
      extra_notes = COALESCE(excluded.extra_notes, lead_profiles.extra_notes),
      updated_at = CURRENT_TIMESTAMP
    `,
  ).run(
    patch.customerPhone,
    patch.name ?? null,
    patch.email ?? null,
    patch.intentType ?? null,
    patch.ref ?? null,
    patch.budget ?? null,
    patch.monthlyIncome ?? null,
    patch.hasGuarantor == null ? null : patch.hasGuarantor ? 1 : 0,
    patch.wantsVisit == null ? null : patch.wantsVisit ? 1 : 0,
    patch.extraNotes ?? null,
  );
}
