import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import path from "node:path";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getDb } from "../db/database.js";
import {
  createSession,
  createUser,
  deleteUser,
  destroySession,
  findUserByName,
  getSessionUser,
  listUsers,
  purgeExpiredSessions,
  seedAdminFromEnv,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  verifyPassword,
  type PanelUser,
} from "./auth.js";
import { aiActionStats, countAiActions, listAiActions } from "./aiActions.js";
import { getVoiceCall, getVoiceCallTurns } from "../voice/voiceCallStore.js";
import { getDesenlaceByCallId, listDesenlaces } from "../db/leads.js";

const COOKIE_NAME = "manuel_panel";

declare module "express-serve-static-core" {
  interface Request {
    panelUser?: PanelUser;
  }
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

function setSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.panelSecureCookie) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Freno a la fuerza bruta: bloquea por IP tras varios fallos seguidos. */
const loginFailures = new Map<string, { count: number; until: number }>();
const MAX_LOGIN_FAILURES = 8;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function loginBlocked(key: string): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_FAILURES;
}

function noteLoginFailure(key: string): void {
  const entry = loginFailures.get(key);
  const count = (entry && Date.now() <= entry.until ? entry.count : 0) + 1;
  loginFailures.set(key, { count, until: Date.now() + LOGIN_BLOCK_MS });
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getSessionUser(readCookie(req, COOKIE_NAME));
  if (!user) {
    res.status(401).json({ error: "no_autenticado" });
    return;
  }
  req.panelUser = user;
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.panelUser?.role !== "admin") {
    res.status(403).json({ error: "solo_admin" });
    return;
  }
  next();
}

function intParam(raw: unknown, fallback: number): number {
  const n = Number.parseInt(Array.isArray(raw) ? String(raw[0]) : String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function strParam(raw: unknown): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Carpeta con el frontend estático (funciona desde src/ con tsx y desde dist/ compilado). */
function resolvePanelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../public/panel"),
    path.resolve(process.cwd(), "public/panel"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[1]!;
}

function recordingsRoot(): string {
  const dir = path.resolve(process.cwd(), config.voiceRecordingsDir);
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Solo se sirven audios que estén realmente dentro del directorio de grabaciones. */
function safeRecordingPath(audioPath: string): string | null {
  const root = recordingsRoot();
  const abs = path.isAbsolute(audioPath)
    ? audioPath
    : path.resolve(process.cwd(), config.voiceRecordingsDir, audioPath);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return real;
}

async function readHealthStatus(): Promise<{ state: string; checkedAt: string | null }> {
  try {
    const raw = (await readFile(config.panelHealthStatusFile, "utf8")).trim();
    const [state, ts] = raw.split(/\s+/);
    return { state: state ?? "desconocido", checkedAt: ts ?? null };
  } catch {
    return { state: "desconocido", checkedAt: null };
  }
}

export function registerPanelRoutes(app: Express): void {
  seedAdminFromEnv();
  purgeExpiredSessions();
  setInterval(() => {
    try {
      purgeExpiredSessions();
    } catch {
      // ignore
    }
  }, 60 * 60 * 1000).unref();

  const api = express.Router();

  api.post("/login", (req, res) => {
    const ipKey = req.ip ?? "desconocida";
    if (loginBlocked(ipKey)) {
      res.status(429).json({ error: "demasiados_intentos" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const username = strParam(body?.username) ?? "";
    const password = typeof body?.password === "string" ? body.password : "";
    const user = username ? findUserByName(username) : null;
    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      noteLoginFailure(ipKey);
      res.status(401).json({ error: "credenciales_invalidas" });
      return;
    }
    loginFailures.delete(ipKey);
    const session = createSession(user.id, req.ip, req.get("user-agent") ?? undefined);
    setSessionCookie(res, session.token, config.panelSessionHours * 3600);
    res.json({ ok: true, user: { username: user.username, role: user.role } });
  });

  api.post("/logout", (req, res) => {
    destroySession(readCookie(req, COOKIE_NAME));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.get("/me", requireAuth, (req, res) => {
    res.json({ ok: true, user: { username: req.panelUser!.username, role: req.panelUser!.role } });
  });

  api.get("/overview", requireAuth, (_req, res) => {
    void (async () => {
      const db = getDb();
      const one = <T>(sql: string, ...params: unknown[]): T =>
        db.prepare(sql).get(...params) as T;

      const calls24 = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM voice_calls WHERE datetime(started_at) > datetime('now', '-24 hours')`,
      );
      const calls7d = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM voice_calls WHERE datetime(started_at) > datetime('now', '-7 days')`,
      );
      const unanswered = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM voice_calls
         WHERE datetime(started_at) > datetime('now', '-7 days')
           AND id NOT IN (SELECT DISTINCT call_id FROM voice_call_turns WHERE role = 'assistant')`,
      );
      const avgDuration = one<{ s: number | null }>(
        `SELECT AVG(strftime('%s', ended_at) - strftime('%s', started_at)) AS s
         FROM voice_calls
         WHERE ended_at IS NOT NULL AND datetime(started_at) > datetime('now', '-7 days')`,
      );
      const msgs24 = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM conversations WHERE datetime(timestamp) > datetime('now', '-24 hours')`,
      );
      const chats7d = one<{ n: number }>(
        `SELECT COUNT(DISTINCT phone_number) AS n FROM conversations
         WHERE datetime(timestamp) > datetime('now', '-7 days')`,
      );
      const leads7d = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM lead_notifications
         WHERE datetime(created_at) > datetime('now', '-7 days')`,
      );
      const muted = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM muted_contacts WHERE datetime(muted_until) > datetime('now')`,
      );
      const recordings = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM voice_calls WHERE audio_path IS NOT NULL AND audio_path <> ''`,
      );

      res.json({
        ok: true,
        health: await readHealthStatus(),
        voice: {
          last24h: calls24.n,
          last7d: calls7d.n,
          mudas7d: unanswered.n,
          duracionMediaSeg: avgDuration.s != null ? Math.round(avgDuration.s) : null,
          conAudio: recordings.n,
        },
        whatsapp: { mensajes24h: msgs24.n, chats7d: chats7d.n, silenciados: muted.n },
        leads: { last7d: leads7d.n },
        acciones: aiActionStats(24),
      });
    })().catch((e) => {
      console.error("[panel] overview", e);
      res.status(500).json({ error: "overview_failed" });
    });
  });

  api.get("/calls", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 50), 1), 200);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const q = strParam(req.query.q);
    const db = getDb();
    const where = q ? `WHERE c.caller LIKE ? OR c.summary LIKE ? OR c.intent LIKE ?` : "";
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const rows = db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM voice_call_turns t WHERE t.call_id = c.id) AS turns,
                (SELECT COUNT(*) FROM voice_call_turns t WHERE t.call_id = c.id AND t.role = 'assistant') AS assistant_turns,
                (SELECT COUNT(*) FROM ai_actions a WHERE a.channel_id = c.id) AS actions
         FROM voice_calls c
         ${where}
         ORDER BY c.started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM voice_calls c ${where}`)
      .get(...params) as { n: number };
    res.json({ ok: true, calls: rows, total: total.n });
  });

  api.get("/calls/:id", requireAuth, (req, res) => {
    const id = String(req.params.id);
    const call = getVoiceCall(id);
    if (!call) {
      res.status(404).json({ error: "llamada_no_encontrada" });
      return;
    }
    const audio = call.audio_path ? safeRecordingPath(call.audio_path) : null;
    res.json({
      ok: true,
      call,
      turns: getVoiceCallTurns(id),
      actions: listAiActions({ channelId: id, limit: 200 }),
      desenlace: getDesenlaceByCallId(id),
      audioDisponible: Boolean(audio),
    });
  });

  api.get("/calls/:id/audio", requireAuth, (req, res) => {
    const call = getVoiceCall(String(req.params.id));
    const file = call?.audio_path ? safeRecordingPath(call.audio_path) : null;
    if (!file) {
      res.status(404).json({ error: "audio_no_disponible" });
      return;
    }
    const stat = statSync(file);
    const type = file.endsWith(".mp3") ? "audio/mpeg" : file.endsWith(".wav") ? "audio/wav" : "audio/ogg";
    res.setHeader("Content-Type", type);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");

    // Range: sin esto el reproductor no deja saltar dentro del audio.
    const range = req.headers.range;
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
        return;
      }
      const safeEnd = Math.min(end, stat.size - 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${stat.size}`);
      res.setHeader("Content-Length", String(safeEnd - start + 1));
      createReadStream(file, { start, end: safeEnd }).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(file).pipe(res);
  });

  api.get("/whatsapp/chats", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 50), 1), 200);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const q = strParam(req.query.q);
    const db = getDb();
    const where = q ? `WHERE c.phone_number LIKE ?` : "";
    const params = q ? [`%${q.replace(/\D+/g, "")}%`] : [];
    const rows = db
      .prepare(
        `SELECT c.phone_number,
                COUNT(*) AS mensajes,
                MAX(c.timestamp) AS ultimo,
                (SELECT content FROM conversations x
                  WHERE x.phone_number = c.phone_number
                  ORDER BY x.timestamp DESC, x.id DESC LIMIT 1) AS ultimo_texto,
                (SELECT role FROM conversations x
                  WHERE x.phone_number = c.phone_number
                  ORDER BY x.timestamp DESC, x.id DESC LIMIT 1) AS ultimo_rol,
                (SELECT name FROM lead_profiles p WHERE p.customer_phone = c.phone_number) AS nombre,
                (SELECT 1 FROM muted_contacts m
                  WHERE m.phone_number = c.phone_number
                    AND datetime(m.muted_until) > datetime('now')) AS silenciado
         FROM conversations c
         ${where}
         GROUP BY c.phone_number
         ORDER BY ultimo DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json({ ok: true, chats: rows });
  });

  api.get("/whatsapp/chats/:phone", requireAuth, (req, res) => {
    const phone = String(req.params.phone).replace(/\D+/g, "");
    const limit = Math.min(Math.max(intParam(req.query.limit, 200), 1), 1000);
    const db = getDb();
    const messages = db
      .prepare(
        `SELECT role, content, timestamp FROM conversations
         WHERE phone_number = ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(phone, limit) as Array<{ role: string; content: string; timestamp: string }>;
    const profile = db
      .prepare(`SELECT * FROM lead_profiles WHERE customer_phone = ?`)
      .get(phone) ?? null;
    const muted = db
      .prepare(
        `SELECT reason, muted_until FROM muted_contacts
         WHERE phone_number = ? AND datetime(muted_until) > datetime('now')`,
      )
      .get(phone) ?? null;
    res.json({
      ok: true,
      phone,
      profile,
      muted,
      messages: messages.reverse(),
      actions: listAiActions({ channelId: phone, limit: 100 }),
    });
  });

  api.get("/leads", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 100), 1), 500);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const rows = getDb()
      .prepare(
        `SELECT l.*, (SELECT name FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS nombre,
                (SELECT email FROM lead_profiles p WHERE p.customer_phone = l.customer_phone) AS email
         FROM lead_notifications l
         ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    res.json({ ok: true, leads: rows });
  });

  api.get("/desenlaces", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 100), 1), 500);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const rows = listDesenlaces(limit, offset);
    res.json({ ok: true, desenlaces: rows, total: rows.length });
  });

  api.get("/emails", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 100), 1), 500);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const q = strParam(req.query.q)?.toLowerCase() ?? "";
    const db = getDb();
    const inbound = db
      .prepare(
        `SELECT uid, processed_at AS at, portal, from_address, customer_email, customer_phone,
                subject_snippet, body_snippet, handled, suppress_reason, 'inbound' AS dir
         FROM email_state
         ORDER BY processed_at DESC
         LIMIT 300`,
      )
      .all() as Array<Record<string, unknown>>;
    const outbound = db
      .prepare(
        `SELECT id AS uid, sent_at AS at, NULL AS portal, to_address AS from_address,
                to_address AS customer_email, NULL AS customer_phone,
                subject_snippet, NULL AS body_snippet, 1 AS handled, NULL AS suppress_reason,
                'outbound' AS dir
         FROM email_outbound_log
         ORDER BY sent_at DESC
         LIMIT 300`,
      )
      .all() as Array<Record<string, unknown>>;
    let emails = [...inbound, ...outbound].sort((a, b) =>
      String(b.at ?? "").localeCompare(String(a.at ?? "")),
    );
    if (q) {
      emails = emails.filter((e) => {
        const hay = [
          e.from_address,
          e.customer_email,
          e.customer_phone,
          e.subject_snippet,
          e.body_snippet,
          e.portal,
        ]
          .map((x) => String(x ?? "").toLowerCase())
          .join(" ");
        return hay.includes(q);
      });
    }
    const total = emails.length;
    emails = emails.slice(offset, offset + limit);
    res.json({ ok: true, emails, total });
  });

  api.get("/actions", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(intParam(req.query.limit, 100), 1), 500);
    const offset = Math.max(intParam(req.query.offset, 0), 0);
    const tool = strParam(req.query.tool);
    const onlyErrors = strParam(req.query.errores) === "1";
    res.json({
      ok: true,
      actions: listAiActions({ limit, offset, tool, onlyErrors }),
      total: countAiActions({ tool, onlyErrors }),
      stats: aiActionStats(intParam(req.query.horas, 24)),
    });
  });

  api.get("/users", requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true, users: listUsers() });
  });

  api.post("/users", requireAuth, requireAdmin, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const username = strParam(body?.username);
    const password = typeof body?.password === "string" ? body.password : "";
    const role = strParam(body?.role) === "admin" ? "admin" : "viewer";
    if (!username) {
      res.status(400).json({ error: "usuario_requerido" });
      return;
    }
    try {
      res.json({ ok: true, user: createUser({ username, password, role }) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "error" });
    }
  });

  api.post("/users/:id", requireAuth, requireAdmin, (req, res) => {
    const id = intParam(req.params.id, 0);
    const body = req.body as Record<string, unknown>;
    if (!id) {
      res.status(400).json({ error: "id_invalido" });
      return;
    }
    try {
      if (typeof body?.password === "string" && body.password) setUserPassword(id, body.password);
      const role = strParam(body?.role);
      if (role === "admin" || role === "viewer") setUserRole(id, role);
      if (typeof body?.disabled === "boolean") setUserDisabled(id, body.disabled);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "error" });
    }
  });

  api.delete("/users/:id", requireAuth, requireAdmin, (req, res) => {
    const id = intParam(req.params.id, 0);
    if (!id || id === req.panelUser!.id) {
      res.status(400).json({ error: "no_puedes_borrarte" });
      return;
    }
    deleteUser(id);
    res.json({ ok: true });
  });

  app.use("/panel/api", api);
  app.use("/panel", express.static(resolvePanelDir(), { index: "index.html" }));
  app.get("/panel", (_req, res) => {
    res.sendFile(path.join(resolvePanelDir(), "index.html"));
  });
}
