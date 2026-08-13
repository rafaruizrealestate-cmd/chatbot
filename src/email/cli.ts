import "dotenv/config";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { runEmailPoll } from "./monitor.js";
import { config } from "../config.js";

function acquireLock(lockPath: string): number | null {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    return openSync(lockPath, "wx");
  } catch {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (ageMs > 10 * 60 * 1000) {
        unlinkSync(lockPath);
        return openSync(lockPath, "wx");
      }
    } catch {
      // ignore
    }
    return null;
  }
}

function releaseLock(fd: number | null, lockPath: string): void {
  if (fd == null) return;
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  if (!config.emailEnabled) {
    console.log("[email] EMAIL_ENABLED=0, saliendo.");
    return;
  }
  if (!config.emailUser || !config.emailPass) {
    console.log("[email] Credenciales de email no configuradas, saliendo.");
    return;
  }

  const lockPath = process.env.EMAIL_LOCK_PATH ?? path.join(process.cwd(), "tmp", "email-poll.lock");
  const fd = acquireLock(lockPath);
  if (fd == null) {
    console.log("[email] Otro proceso ya está ejecutándose, saliendo.");
    return;
  }

  try {
    await runEmailPoll();
  } finally {
    releaseLock(fd, lockPath);
  }
}

main().catch((e) => {
  console.error("[email] Error fatal", e);
  process.exit(1);
});
