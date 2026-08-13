import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../config.js";
import { appendToSent } from "./imapClient.js";

export async function appendArchiveNoteToSent(opts: {
  subject: string;
  text: string;
}): Promise<void> {
  const from = `"${config.emailFromName}" <${config.emailUser}>`;
  const to = config.emailUser;
  if (!to.trim()) throw new Error("EMAIL_USER vacío: no se puede archivar en Enviados");

  const raw = await new MailComposer({
    from,
    to,
    subject: opts.subject.slice(0, 240),
    text: opts.text,
    date: new Date(),
  })
    .compile()
    .build();

  await appendToSent(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
}

