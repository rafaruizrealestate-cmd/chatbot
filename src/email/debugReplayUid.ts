import "dotenv/config";
import { fetchEmailByUid } from "./imapClient.js";
import { classifyEmail } from "./classifier.js";
import { debugResolvePropertyFromMessage } from "../whatsapp/processIncomingText.js";

function parseUidArg(argv: string[]): number | null {
  const m = argv.join(" ").match(/--uid=(\d{1,9})/);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const uid = parseUidArg(process.argv.slice(2));
  if (!uid) {
    console.error("Uso: node dist/email/debugReplayUid.js --uid=24269");
    process.exitCode = 1;
    return;
  }

  const email = await fetchEmailByUid(uid);
  if (!email) {
    console.error(`No se pudo descargar el UID ${uid} por IMAP. Comprueba que existe en INBOX y credenciales IMAP.`);
    process.exitCode = 2;
    return;
  }

  const classified = classifyEmail(email);
  const resolved = await debugResolvePropertyFromMessage(classified.messageText);

  // Output humano (no logs del sistema)
  console.log(JSON.stringify({ uid, portal: classified.portal, propertyRefExtracted: classified.propertyRef, resolved }, null, 2));
}

main().catch((e) => {
  console.error("debugReplayUid error", e);
  process.exitCode = 1;
});

