import type { CheerioAPI } from "cheerio";

export type ScrapedAgentMeta = {
  agent_name: string;
  agent_phone: string;
  agent_user_id: number | null;
};

function normalizeAgentPhone(raw: string): string | null {
  const d = raw.replace(/\D+/g, "");
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

function formatAgentDisplayName(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (t === t.toUpperCase() && t.length <= 30) {
    return t.charAt(0) + t.slice(1).toLowerCase();
  }
  return t;
}

/** Lee meta invisible bazan:agent-* de la ficha pública. */
export function parseAgentMetaFromCheerio($: CheerioAPI): ScrapedAgentMeta | null {
  const nameRaw = ($('meta[name="bazan:agent-name"]').attr("content") ?? "").trim();
  const phoneRaw = ($('meta[name="bazan:agent-phone"]').attr("content") ?? "").trim();
  const userIdRaw = ($('meta[name="bazan:agent-user-id"]').attr("content") ?? "").trim();

  const phone = normalizeAgentPhone(phoneRaw);
  if (!phone || !nameRaw) return null;

  const userId = Number.parseInt(userIdRaw, 10);
  return {
    agent_name: formatAgentDisplayName(nameRaw),
    agent_phone: phone,
    agent_user_id: Number.isFinite(userId) && userId > 0 ? userId : null,
  };
}
