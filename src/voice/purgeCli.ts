import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { purgeVoiceCallsOlderThan } from "./voiceCallStore.js";
import { purgeAiActionsOlderThan } from "../panel/aiActions.js";

/**
 * Purga el histórico de voz (BD + audios) más antiguo que VOICE_RETENTION_DAYS.
 * Pensado para ejecutarse por cron: `npm run voice:purge`.
 */
async function purgeRecordings(days: number): Promise<number> {
  const dir = config.voiceRecordingsDir;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const s = await stat(full);
      if (s.isFile() && s.mtimeMs < cutoff) {
        await unlink(full);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const days = config.voiceRetentionDays;
  const calls = purgeVoiceCallsOlderThan(days);
  const audios = await purgeRecordings(days);
  const actions = purgeAiActionsOlderThan(days);
  console.log(
    `[voice/purge] Retención ${days} días → ${calls} llamadas, ${audios} audios y ${actions} acciones eliminadas`,
  );
}

main().catch((e) => {
  console.error("[voice/purge] error", e);
  process.exit(1);
});
