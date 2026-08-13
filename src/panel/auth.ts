import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/database.js";
import { config } from "../config.js";

export type PanelRole = "admin" | "viewer";

export type PanelUser = {
  id: number;
  username: string;
  role: PanelRole;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
};

type PanelUserRow = PanelUser & { password_hash: string };

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;
const KEY_LEN = 64;

/** Formato: scrypt$N$r$p$saltB64$hashB64 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
  });
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK,
    SCRYPT_PARALLEL,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(String(hashB64), "base64");
    const actual = scryptSync(password, Buffer.from(String(saltB64), "base64"), expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function countUsers(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM panel_users`).get() as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

export function listUsers(): PanelUser[] {
  return getDb()
    .prepare(
      `SELECT id, username, role, disabled, created_at, last_login_at
       FROM panel_users ORDER BY username`,
    )
    .all() as PanelUser[];
}

export function findUserByName(username: string): PanelUserRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM panel_users WHERE username = ?`)
    .get(username.trim()) as PanelUserRow | undefined;
  return row ?? null;
}

export function getUserById(id: number): PanelUser | null {
  const row = getDb()
    .prepare(
      `SELECT id, username, role, disabled, created_at, last_login_at FROM panel_users WHERE id = ?`,
    )
    .get(id) as PanelUser | undefined;
  return row ?? null;
}

export function createUser(input: {
  username: string;
  password: string;
  role?: PanelRole;
}): PanelUser {
  const username = input.username.trim();
  if (!/^[\w.@-]{3,40}$/.test(username)) {
    throw new Error("Usuario inválido (3-40 caracteres: letras, números, . _ - @)");
  }
  if (input.password.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres");
  }
  getDb()
    .prepare(`INSERT INTO panel_users (username, password_hash, role) VALUES (?, ?, ?)`)
    .run(username, hashPassword(input.password), input.role ?? "viewer");
  const created = findUserByName(username);
  if (!created) throw new Error("No se pudo crear el usuario");
  return {
    id: created.id,
    username: created.username,
    role: created.role,
    disabled: created.disabled,
    created_at: created.created_at,
    last_login_at: created.last_login_at,
  };
}

export function setUserPassword(id: number, password: string): void {
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres");
  getDb().prepare(`UPDATE panel_users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), id);
  // Cambiar la contraseña cierra las sesiones abiertas de ese usuario.
  getDb().prepare(`DELETE FROM panel_sessions WHERE user_id = ?`).run(id);
}

export function setUserRole(id: number, role: PanelRole): void {
  getDb().prepare(`UPDATE panel_users SET role = ? WHERE id = ?`).run(role, id);
}

export function setUserDisabled(id: number, disabled: boolean): void {
  getDb().prepare(`UPDATE panel_users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id);
  if (disabled) getDb().prepare(`DELETE FROM panel_sessions WHERE user_id = ?`).run(id);
}

export function deleteUser(id: number): void {
  getDb().prepare(`DELETE FROM panel_sessions WHERE user_id = ?`).run(id);
  getDb().prepare(`DELETE FROM panel_users WHERE id = ?`).run(id);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type NewSession = { token: string; expiresAt: string };

export function createSession(userId: number, ip?: string, userAgent?: string): NewSession {
  const token = randomBytes(32).toString("base64url");
  const hours = config.panelSessionHours;
  const db = getDb();
  db.prepare(
    `INSERT INTO panel_sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, datetime('now', ?), ?, ?)`,
  ).run(tokenHash(token), userId, `+${hours} hours`, ip ?? null, (userAgent ?? "").slice(0, 200));
  db.prepare(`UPDATE panel_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId);
  const row = db
    .prepare(`SELECT expires_at FROM panel_sessions WHERE token_hash = ?`)
    .get(tokenHash(token)) as { expires_at: string } | undefined;
  return { token, expiresAt: row?.expires_at ?? "" };
}

/** Devuelve el usuario de la sesión y renueva la caducidad si queda menos de la mitad. */
export function getSessionUser(token: string): PanelUser | null {
  if (!token) return null;
  const db = getDb();
  const hash = tokenHash(token);
  const row = db
    .prepare(
      `SELECT s.user_id, s.expires_at, u.id, u.username, u.role, u.disabled, u.created_at, u.last_login_at
       FROM panel_sessions s
       JOIN panel_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')`,
    )
    .get(hash) as (PanelUser & { user_id: number; expires_at: string }) | undefined;
  if (!row || row.disabled) return null;

  db.prepare(
    `UPDATE panel_sessions SET expires_at = datetime('now', ?)
     WHERE token_hash = ?
       AND datetime(expires_at) < datetime('now', ?)`,
  ).run(`+${config.panelSessionHours} hours`, hash, `+${Math.floor(config.panelSessionHours / 2)} hours`);

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function destroySession(token: string): void {
  if (!token) return;
  getDb().prepare(`DELETE FROM panel_sessions WHERE token_hash = ?`).run(tokenHash(token));
}

export function purgeExpiredSessions(): number {
  const r = getDb()
    .prepare(`DELETE FROM panel_sessions WHERE datetime(expires_at) <= datetime('now')`)
    .run();
  return r.changes;
}

/**
 * Crea el admin inicial desde PANEL_ADMIN_USER / PANEL_ADMIN_PASSWORD si aún no hay usuarios.
 * Sin esas variables el panel queda sin acceso hasta crear un usuario por CLI.
 */
export function seedAdminFromEnv(): void {
  if (countUsers() > 0) return;
  const username = config.panelAdminUser.trim();
  const password = config.panelAdminPassword;
  if (!username || !password) {
    console.warn(
      "[panel] Sin usuarios y sin PANEL_ADMIN_USER/PANEL_ADMIN_PASSWORD: crea uno con `npm run panel:user`",
    );
    return;
  }
  try {
    createUser({ username, password, role: "admin" });
    console.log(`[panel] Usuario admin inicial creado: ${username}`);
  } catch (e) {
    console.error("[panel] No se pudo crear el admin inicial", e);
  }
}
