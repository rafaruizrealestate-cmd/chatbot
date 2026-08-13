import { getDb } from "../db/database.js";

export type AiActionSource = "voice" | "whatsapp";

export type AiActionRow = {
  id: number;
  source: string;
  channel_id: string | null;
  phone: string | null;
  tool: string;
  input_json: string | null;
  output_json: string | null;
  ok: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
};

export type RecordAiActionInput = {
  source: AiActionSource;
  /** callId de voz o teléfono de WhatsApp: agrupa las acciones de una misma conversación. */
  channelId?: string | null;
  phone?: string | null;
  tool: string;
  input?: unknown;
  output?: unknown;
  ok?: boolean;
  error?: string | null;
  durationMs?: number | null;
};

/** Recorta payloads grandes para que la tabla no crezca sin control. */
function toJson(value: unknown, maxChars = 4000): string | null {
  if (value === undefined || value === null) return null;
  try {
    const s = JSON.stringify(value);
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
  } catch {
    return null;
  }
}

/** Nunca debe tumbar una llamada en curso: los fallos se loguean y se ignoran. */
export function recordAiAction(input: RecordAiActionInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_actions
           (source, channel_id, phone, tool, input_json, output_json, ok, error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.source,
        input.channelId ?? null,
        input.phone ? input.phone.replace(/\D+/g, "") : null,
        input.tool,
        toJson(input.input),
        toJson(input.output),
        input.ok === false ? 0 : 1,
        input.error ?? null,
        input.durationMs != null ? Math.round(input.durationMs) : null,
      );
  } catch (e) {
    console.warn("[ai-actions] no se pudo registrar la acción", { tool: input.tool, error: e });
  }
}

/** Ejecuta `fn` midiendo cuánto tarda y deja rastro en ai_actions. */
export async function trackAiAction<T>(
  meta: Omit<RecordAiActionInput, "output" | "ok" | "error" | "durationMs">,
  fn: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    recordAiAction({ ...meta, output: result, ok: true, durationMs: Date.now() - started });
    return result;
  } catch (e) {
    recordAiAction({
      ...meta,
      ok: false,
      error: String(e instanceof Error ? e.message : e).slice(0, 500),
      durationMs: Date.now() - started,
    });
    throw e;
  }
}

export function listAiActions(opts: {
  limit?: number;
  offset?: number;
  channelId?: string;
  tool?: string;
  onlyErrors?: boolean;
}): AiActionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.channelId) {
    where.push("channel_id = ?");
    params.push(opts.channelId);
  }
  if (opts.tool) {
    where.push("tool = ?");
    params.push(opts.tool);
  }
  if (opts.onlyErrors) where.push("ok = 0");
  const sql = `SELECT * FROM ai_actions ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  return getDb()
    .prepare(sql)
    .all(...params, limit, offset) as AiActionRow[];
}

export function countAiActions(opts: { channelId?: string; tool?: string; onlyErrors?: boolean }): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.channelId) {
    where.push("channel_id = ?");
    params.push(opts.channelId);
  }
  if (opts.tool) {
    where.push("tool = ?");
    params.push(opts.tool);
  }
  if (opts.onlyErrors) where.push("ok = 0");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    )
    .get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export type ToolLatencyStat = {
  tool: string;
  count: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

/**
 * Latencia por herramienta en las últimas `hours` horas.
 * Es lo que delata los silencios incómodos: si p95 sube, Lara se queda muda esperando.
 */
export function aiActionStats(hours = 24): ToolLatencyStat[] {
  const rows = getDb()
    .prepare(
      `SELECT tool, ok, duration_ms FROM ai_actions
       WHERE datetime(created_at) > datetime('now', ?)`,
    )
    .all(`-${Math.max(1, hours)} hours`) as Array<{
    tool: string;
    ok: number;
    duration_ms: number | null;
  }>;

  const byTool = new Map<string, { durations: number[]; count: number; errors: number }>();
  for (const r of rows) {
    const entry = byTool.get(r.tool) ?? { durations: [], count: 0, errors: 0 };
    entry.count += 1;
    if (!r.ok) entry.errors += 1;
    if (r.duration_ms != null) entry.durations.push(r.duration_ms);
    byTool.set(r.tool, entry);
  }

  return [...byTool.entries()]
    .map(([tool, e]) => {
      const sorted = [...e.durations].sort((a, b) => a - b);
      return {
        tool,
        count: e.count,
        errors: e.errors,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.length ? sorted[sorted.length - 1]! : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Borra acciones anteriores a N días (se llama desde la purga de voz). */
export function purgeAiActionsOlderThan(days: number): number {
  const r = getDb()
    .prepare(`DELETE FROM ai_actions WHERE datetime(created_at) < datetime('now', ?)`)
    .run(`-${Math.max(1, days)} days`);
  return r.changes;
}
