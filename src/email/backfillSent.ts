import "dotenv/config";
import { getDb } from "../db/database.js";
import { config } from "../config.js";
import { appendToSent } from "./imapClient.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

type EmailStateRow = {
  uid: number;
  processed_at: string;
  portal: string | null;
  from_address: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  handled: number;
};

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

function keyForConversation(row: EmailStateRow): string {
  const phone = (row.customer_phone ?? "").trim();
  if (phone) return phone;
  const email = (row.customer_email ?? "").trim();
  if (email) return email;
  return `email:${(row.portal ?? "unknown").trim() || "unknown"}:${row.uid}`;
}

async function appendBackfillToSent(opts: {
  toHint: string;
  subject: string;
  text: string;
}): Promise<void> {
  const from = `"${config.emailFromName}" <${config.emailUser}>`;
  const to = config.emailUser;
  const raw = await new MailComposer({
    from,
    to,
    subject: opts.subject.slice(0, 240),
    text: `BACKFILL (copia interna para control; no se re-envía)\nDestino original (aprox): ${opts.toHint}\n\n--- Respuesta ---\n${opts.text}\n`,
    date: new Date(),
  })
    .compile()
    .build();
  await appendToSent(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fromTs = args["from"]; // 'YYYY-MM-DD HH:MM:SS'
  const toTs = args["to"]; // idem
  const onlyDirect = (args["direct"] ?? "1") === "1";
  const limit = Number.parseInt(args["limit"] ?? "500", 10);

  const db = getDb();
  const whereParts = ["handled = 1"];
  const params: unknown[] = [];
  if (onlyDirect) whereParts.push("(portal is null or portal = '')");
  if (fromTs) {
    whereParts.push("datetime(processed_at) >= ?");
    params.push(fromTs);
  }
  if (toTs) {
    whereParts.push("datetime(processed_at) <= ?");
    params.push(toTs);
  }

  const rows = db
    .prepare(
      `SELECT uid, processed_at, portal, from_address, customer_email, customer_phone, handled
       FROM email_state
       WHERE ${whereParts.join(" AND ")}
       ORDER BY processed_at ASC
       LIMIT ?`
    )
    .all(...params, Number.isFinite(limit) ? limit : 500) as EmailStateRow[];

  console.log(`[backfill] candidatos: ${rows.length}`);
  let ok = 0;
  let miss = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const key = keyForConversation(row);
      const assistant = db
        .prepare(
          `SELECT content
           FROM conversations
           WHERE phone_number = ?
             AND role = 'assistant'
           ORDER BY timestamp DESC
           LIMIT 1`
        )
        .get(key) as { content?: string } | undefined;

      const text = assistant?.content?.trim();
      if (!text) {
        miss++;
        continue;
      }

      const subject = `BACKFILL: Respuesta automática (UID ${row.uid})`;
      const toHint = (row.customer_email ?? row.from_address ?? key).trim();

      await appendBackfillToSent({
        toHint,
        subject,
        text,
      });
      ok++;
    } catch (e) {
      failed++;
      console.warn(`[backfill] UID ${row.uid} falló:`, e);
    }
  }

  console.log(`[backfill] append ok=${ok} sin_respuesta_en_DB=${miss} fallos=${failed}`);
}

main().catch((e) => {
  console.error("[backfill] error", e);
  process.exitCode = 1;
});

