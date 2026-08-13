import { randomUUID } from "node:crypto";
import { getDb } from "../db/database.js";

export type VoiceCallRow = {
  id: string;
  pbx_call_id: string | null;
  caller: string;
  called_did: string | null;
  language: string | null;
  intent: string | null;
  summary: string | null;
  disposition: string | null;
  audio_path: string | null;
  started_at: string;
  ended_at: string | null;
};

export type VoiceCallTurnRow = {
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
};

export function startVoiceCall(input: {
  caller: string;
  calledDid?: string | null;
  pbxCallId?: string | null;
}): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO voice_calls (id, pbx_call_id, caller, called_did) VALUES (?, ?, ?, ?)`
  ).run(id, input.pbxCallId ?? null, input.caller.replace(/\D+/g, ""), input.calledDid ?? null);
  return id;
}

export function appendVoiceTurn(
  callId: string,
  role: "user" | "assistant" | "system",
  text: string
): void {
  const t = text.trim();
  if (!t) return;
  const db = getDb();
  db.prepare(`INSERT INTO voice_call_turns (call_id, role, text) VALUES (?, ?, ?)`).run(
    callId,
    role,
    t
  );
}

export function endVoiceCall(
  callId: string,
  patch: {
    summary?: string | null;
    intent?: string | null;
    disposition?: string | null;
    language?: string | null;
    audioPath?: string | null;
  }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE voice_calls SET
       ended_at = CURRENT_TIMESTAMP,
       summary = COALESCE(?, summary),
       intent = COALESCE(?, intent),
       disposition = COALESCE(?, disposition),
       language = COALESCE(?, language),
       audio_path = COALESCE(?, audio_path)
     WHERE id = ?`
  ).run(
    patch.summary ?? null,
    patch.intent ?? null,
    patch.disposition ?? null,
    patch.language ?? null,
    patch.audioPath ?? null,
    callId
  );
}

export function setVoiceCallMeta(
  callId: string,
  patch: { intent?: string | null; language?: string | null; audioPath?: string | null }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE voice_calls SET
       intent = COALESCE(?, intent),
       language = COALESCE(?, language),
       audio_path = COALESCE(?, audio_path)
     WHERE id = ?`
  ).run(patch.intent ?? null, patch.language ?? null, patch.audioPath ?? null, callId);
}

export function getVoiceCall(callId: string): VoiceCallRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM voice_calls WHERE id = ?`).get(callId) as
    | VoiceCallRow
    | undefined;
  return row ?? null;
}

export function getVoiceCallByPbxId(pbxCallId: string): VoiceCallRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM voice_calls WHERE pbx_call_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(pbxCallId) as VoiceCallRow | undefined;
  return row ?? null;
}

export function listVoiceCalls(limit = 50, offset = 0): VoiceCallRow[] {
  const db = getDb();
  const l = Math.min(Math.max(limit, 1), 200);
  return db
    .prepare(`SELECT * FROM voice_calls ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(l, Math.max(offset, 0)) as VoiceCallRow[];
}

export function getVoiceCallTurns(callId: string): VoiceCallTurnRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT role, text, ts FROM voice_call_turns WHERE call_id = ? ORDER BY ts, id`)
    .all(callId) as VoiceCallTurnRow[];
}

/** Borra llamadas (y sus turnos) anteriores a N días. Devuelve nº de llamadas eliminadas. */
export function purgeVoiceCallsOlderThan(days: number): number {
  const db = getDb();
  const d = Math.max(days, 1);
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM voice_call_turns WHERE call_id IN (
         SELECT id FROM voice_calls WHERE started_at < datetime('now', ?)
       )`
    ).run(`-${d} days`);
    const r = db.prepare(`DELETE FROM voice_calls WHERE started_at < datetime('now', ?)`).run(
      `-${d} days`
    );
    return r.changes;
  });
  return tx() as number;
}
