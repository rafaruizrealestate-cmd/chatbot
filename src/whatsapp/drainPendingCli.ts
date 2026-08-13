/**
 * Vacía filas legacy en `whatsapp_pending` (el webhook ya no encola en horario bloqueado).
 */
import "dotenv/config";
import { listUnprocessedWhatsappPending, markWhatsappPendingFailed, markWhatsappPendingProcessed } from "../db/whatsappPending.js";
import { processIncomingText } from "./processIncomingText.js";
import { sendEvolutionText } from "./evolutionSender.js";
import { isBlockedByWorkSchedule } from "../utils/workSchedule.js";

async function main(): Promise<void> {
  if (isBlockedByWorkSchedule()) {
    console.log("[whatsapp:drain] Pausado por horario laboral (L-V 10:00-19:30 Europe/Madrid); pendientes en cola");
    return;
  }

  const pending = listUnprocessedWhatsappPending(300);
  if (pending.length === 0) {
    console.log("[whatsapp:drain] No hay pendientes.");
    return;
  }

  console.log("[whatsapp:drain] Pendientes:", pending.length);

  let ok = 0;
  let fail = 0;

  for (const row of pending) {
    try {
      if (row.provider !== "evolution") {
        throw new Error(`Proveedor no soportado en drain: ${row.provider}`);
      }
      await processIncomingText(
        row.conversation_key,
        row.text,
        (to, bodyText) => sendEvolutionText(to, bodyText, row.provider_instance ?? undefined),
        undefined
      );
      markWhatsappPendingProcessed(row.id);
      ok++;
    } catch (e) {
      markWhatsappPendingFailed(row.id, e);
      fail++;
      console.error("[whatsapp:drain] fallo", { id: row.id, conv: row.conversation_key, err: e });
    }
  }

  console.log("[whatsapp:drain] fin", { ok, fail });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

