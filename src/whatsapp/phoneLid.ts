import axios from "axios";
import { getDb } from "../db/database.js";
import { config } from "../config.js";
import { parsePhoneToE164Digits } from "../utils/phone.js";

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

function isLidJid(input: string): boolean {
  return /@lid$/i.test(input.trim());
}

const memoryCache = new Map<string, string>();

type EvoMsgRecord = {
  key?: { remoteJid?: string; remoteJidAlt?: string; id?: string };
};

function digitsPhone(phone: string): string {
  const raw = phone.replace(/\D+/g, "");
  if (!raw) return "";
  return parsePhoneToE164Digits(raw) ?? parsePhoneToE164Digits(`+${raw}`) ?? raw;
}

/** Persiste y cachea phone → @lid. */
export function rememberPhoneLid(phone: string | undefined, lid: string | undefined): void {
  if (!phone || !lid || !isLidJid(lid)) return;
  const d = digitsPhone(phone);
  if (!d) return;
  const cleanLid = lid.trim();
  memoryCache.set(d, cleanLid);
  try {
    getDb()
      .prepare(
        `INSERT INTO phone_lid (phone, lid, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(phone) DO UPDATE SET lid = excluded.lid, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(d, cleanLid);
  } catch (e) {
    console.warn("[phone-lid] no se pudo persistir", { phone: d, error: e });
  }
}

export function getCachedLidForPhone(phone: string): string | undefined {
  const d = digitsPhone(phone);
  if (!d) return undefined;
  const mem = memoryCache.get(d);
  if (mem) return mem;
  try {
    const row = getDb()
      .prepare(`SELECT lid FROM phone_lid WHERE phone = ?`)
      .get(d) as { lid: string } | undefined;
    if (row?.lid && isLidJid(row.lid)) {
      memoryCache.set(d, row.lid);
      return row.lid;
    }
  } catch {
    // tabla aún no migrada
  }
  return undefined;
}

/**
 * Resuelve @lid para un E.164: caché → contactos Evolution → mensajes recientes.
 * Sin LID, WhatsApp suele marcar el envío a @s.whatsapp.net como ERROR.
 */
export async function resolveLidForPhone(
  phone: string,
  instance?: string,
  apiKey?: string,
): Promise<string | undefined> {
  const d = digitsPhone(phone);
  if (!d) return undefined;

  const cached = getCachedLidForPhone(d);
  if (cached) return cached;

  const inst = (instance ?? config.evolutionInstance).trim();
  const key = (apiKey ?? config.evolutionApiKey).trim();
  if (!inst || !key || !config.evolutionBaseUrl) return undefined;

  try {
    const url = joinUrl(config.evolutionBaseUrl, `/chat/findContacts/${encodeURIComponent(inst)}`);
    const res = await axios.post(
      url,
      { where: {} },
      {
        headers: { apikey: key, "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    const contacts = Array.isArray(res.data) ? res.data : [];
    const phoneJid = `${d}@s.whatsapp.net`;
    const phoneContact = contacts.find(
      (c: { remoteJid?: string }) => c?.remoteJid === phoneJid,
    ) as { pushName?: string } | undefined;
    const name = (phoneContact?.pushName ?? "").trim();
    if (name) {
      const lidContact = contacts.find(
        (c: { remoteJid?: string; pushName?: string }) =>
          isLidJid(c?.remoteJid ?? "") && (c?.pushName ?? "").trim() === name,
      ) as { remoteJid?: string } | undefined;
      if (lidContact?.remoteJid) {
        rememberPhoneLid(d, lidContact.remoteJid);
        return lidContact.remoteJid.trim();
      }
    }

    const msgUrl = joinUrl(config.evolutionBaseUrl, `/chat/findMessages/${encodeURIComponent(inst)}`);
    // Buscar por teléfono en remoteJid y en remoteJidAlt (WhatsApp LID suele poner el E.164 en Alt).
    const queries = [
      { where: { key: { remoteJid: phoneJid } }, limit: 8 },
      { where: { key: { remoteJidAlt: phoneJid } }, limit: 8 },
    ];
    for (const body of queries) {
      const msgRes = await axios.post(msgUrl, body, {
        headers: { apikey: key, "Content-Type": "application/json" },
        timeout: 15000,
      });
      const records =
        (msgRes.data as { messages?: { records?: EvoMsgRecord[] } })?.messages?.records ??
        (Array.isArray(msgRes.data) ? (msgRes.data as EvoMsgRecord[]) : []);
      for (const r of records) {
        const alt = r.key?.remoteJidAlt?.trim();
        const remote = r.key?.remoteJid?.trim();
        if (remote && isLidJid(remote)) {
          rememberPhoneLid(d, remote);
          return remote;
        }
        if (alt && isLidJid(alt)) {
          rememberPhoneLid(d, alt);
          return alt;
        }
      }
    }
  } catch (e) {
    console.warn("[phone-lid] resolveLidForPhone falló", { phone: d, error: e });
  }
  return undefined;
}

/** Destino óptimo para sendText: @lid si se puede, si no el teléfono. */
export async function resolveEvolutionSendTarget(
  to: string,
  instance?: string,
  apiKey?: string,
): Promise<string> {
  const trimmed = to.trim();
  if (isLidJid(trimmed)) return trimmed;
  const d = digitsPhone(trimmed);
  if (!d) return trimmed;
  const lid = await resolveLidForPhone(d, instance, apiKey);
  return lid ?? d;
}
