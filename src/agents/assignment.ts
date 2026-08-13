import {
  listDistinctAgentContacts,
  listDistinctAgentPhones,
  searchProperties,
  type PropertyRow,
} from "../knowledge/properties.js";

export type AgentContact = {
  name: string;
  phone: string;
};

function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, "");
}

function agentFromPropertyRow(row: PropertyRow | null | undefined): AgentContact | null {
  if (!row?.agent_phone?.trim() || !row.agent_name?.trim()) return null;
  return {
    name: row.agent_name.trim(),
    phone: normalizePhone(row.agent_phone),
  };
}

function agentFromEnv(prefix: "LEAD_FALLBACK" | "LEAD_OWNER"): AgentContact | null {
  const name = process.env[`${prefix}_AGENT_NAME`]?.trim();
  const phone = process.env[`${prefix}_AGENT_PHONE`]?.trim();
  if (!name || !phone) return null;
  return { name, phone: normalizePhone(phone) };
}

/** Teléfonos de comerciales conocidos (scrape → BD). Para filtrar contactos internos. */
export function listKnownAgentPhones(): string[] {
  return listDistinctAgentPhones();
}

/**
 * Resuelve comercial solo desde scrape/BD (meta bazan:agent-* en ficha).
 * Sin listas manuales de refs ni nombres en código.
 *
 * Fallback opcional vía .env:
 * - LEAD_OWNER_AGENT_* (intent C, propietarios)
 * - LEAD_FALLBACK_AGENT_* (sin ref o ficha sin agente en BD)
 */
export function pickAgent(
  intent: "A" | "B" | "C",
  ref: string | null,
  property?: PropertyRow | null
): AgentContact {
  const fromProperty = agentFromPropertyRow(property);
  if (fromProperty) return fromProperty;

  if (ref) {
    const row = searchProperties({ ref, limit: 1 })[0];
    const fromDb = agentFromPropertyRow(row);
    if (fromDb) return fromDb;
  }

  if (intent === "C") {
    const owner = agentFromEnv("LEAD_OWNER");
    if (owner) return owner;
    return { name: "Álvaro", phone: "34646424563" };
  }

  const fallback = agentFromEnv("LEAD_FALLBACK");
  if (fallback) return fallback;

  const fromDb = listDistinctAgentContacts()[0];
  if (fromDb) {
    console.warn("[agent] Sin agente en ficha/ref; usando primer comercial de BD (revisar scrape)", {
      ref,
      intent,
      agent: fromDb.name,
    });
    return fromDb;
  }

  throw new Error(
    "[agent] No hay comercial en BD ni LEAD_FALLBACK_AGENT_* en .env. Ejecuta npm run scrape."
  );
}
