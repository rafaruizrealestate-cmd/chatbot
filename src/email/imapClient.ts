import { ImapFlow } from "imapflow";
import { config } from "../config.js";
import { simpleParser, type ParsedMail } from "mailparser";

export type FetchedEmail = {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  text: string;
  html: string;
  date: Date | null;
  parsed: ParsedMail;
};

function createClient(): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.emailUser, pass: config.emailPass },
    logger: false,
  });
}

async function listMailboxPaths(client: ImapFlow): Promise<string[]> {
  // imapflow ≥1.3: list() devuelve Promise<MailboxObject[]>; versiones antiguas eran async iterable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listed: unknown = await (client as any).list();
  const boxes: unknown[] = Array.isArray(listed)
    ? listed
    : listed && typeof listed === "object" && Symbol.asyncIterator in listed
      ? await (async () => {
          const out: unknown[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for await (const mb of listed as AsyncIterable<any>) out.push(mb);
          return out;
        })()
      : [];

  const paths: string[] = [];
  for (const mb of boxes) {
    const p = (mb as { path?: unknown })?.path;
    if (typeof p === "string" && p.trim()) paths.push(p.trim());
  }
  return paths;
}

async function resolveSentMailbox(client: ImapFlow): Promise<string> {
  const forced = config.emailSentMailbox?.trim();
  if (forced) return forced;

  const paths = await listMailboxPaths(client);
  const byLower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const candidates = [
    "inbox.sent",
    "sent",
    "enviados",
    "sent items",
    "inbox.enviados",
    "enviados/ sent",
  ];
  for (const c of candidates) {
    const hit = byLower.get(c);
    if (hit) return hit;
  }
  const fuzzy =
    paths.find((p) => /(^|[./])sent($|[./])/i.test(p)) ??
    paths.find((p) => /enviad/i.test(p));
  return fuzzy ?? "INBOX.Sent";
}

export async function appendToSent(rawMime: Buffer): Promise<void> {
  const attempt = async (): Promise<void> => {
    const client = createClient();
    try {
      await client.connect();
      const mailbox = await resolveSentMailbox(client);
      // ImapFlow.append en esta versión espera flags+date como args (no options object).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).append(mailbox, rawMime, ["\\Seen"], new Date());
    } finally {
      await client.logout().catch(() => undefined);
    }
  };

  try {
    await attempt();
  } catch (e) {
    const msg = (e as { message?: unknown })?.message;
    const code = (e as { code?: unknown })?.code;
    const isNoConn = code === "NoConnection" || (typeof msg === "string" && msg.includes("Connection not available"));
    if (!isNoConn) throw e;
    // Un retry suele arreglar cortes puntuales del servidor IMAP
    await attempt();
  }
}

export async function fetchUnseenEmails(limit = 30): Promise<FetchedEmail[]> {
  const client = createClient();
  const results: FetchedEmail[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const uids: number[] = [];
      for await (const msg of client.fetch({ seen: false }, { uid: true })) {
        uids.push(msg.uid);
        if (uids.length >= limit) break;
      }

      for (const uid of uids) {
        const raw = await client.download(String(uid), undefined, { uid: true });
        const parsed = await simpleParser(raw.content);

        results.push({
          uid,
          messageId: parsed.messageId ?? null,
          from: typeof parsed.from?.text === "string" ? parsed.from.text : "",
          subject: parsed.subject ?? "",
          text: parsed.text ?? "",
          html: typeof parsed.html === "string" ? parsed.html : "",
          date: parsed.date ?? null,
          parsed,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return results;
}

export async function fetchEmailByUid(uid: number): Promise<FetchedEmail | null> {
  const client = createClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const raw = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(raw.content);
      return {
        uid,
        messageId: parsed.messageId ?? null,
        from: typeof parsed.from?.text === "string" ? parsed.from.text : "",
        subject: parsed.subject ?? "",
        text: parsed.text ?? "",
        html: typeof parsed.html === "string" ? parsed.html : "",
        date: parsed.date ?? null,
        parsed,
      };
    } finally {
      lock.release();
    }
  } catch {
    return null;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function fetchRecentEmails(limit = 30): Promise<FetchedEmail[]> {
  const client = createClient();
  const results: FetchedEmail[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // IMPORTANTE: algunos servidores IMAP no aceptan rangos tipo "*:-30".
      // Para máxima compatibilidad, listamos UIDs vía SEARCH y nos quedamos con los últimos N.
      const allUids = await client.search({}, { uid: true });
      const uidList = Array.isArray(allUids) ? allUids : [];
      const uids = uidList.slice(-Math.max(1, limit));

      for (const uid of uids) {
        const raw = await client.download(String(uid), undefined, { uid: true });
        const parsed = await simpleParser(raw.content);

        results.push({
          uid,
          messageId: parsed.messageId ?? null,
          from: typeof parsed.from?.text === "string" ? parsed.from.text : "",
          subject: parsed.subject ?? "",
          text: parsed.text ?? "",
          html: typeof parsed.html === "string" ? parsed.html : "",
          date: parsed.date ?? null,
          parsed,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return results;
}

export async function markAsRead(uids: number[]): Promise<void> {
  if (uids.length === 0) return;

  const attempt = async (): Promise<void> => {
    const client = createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd({ uid: uids.join(",") }, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  };

  try {
    await attempt();
  } catch (e) {
    const msg = (e as { message?: unknown })?.message;
    const code = (e as { code?: unknown })?.code;
    const isNoConn =
      code === "NoConnection" ||
      (typeof msg === "string" && msg.includes("Connection not available"));
    if (!isNoConn) throw e;
    await attempt();
  }
}
