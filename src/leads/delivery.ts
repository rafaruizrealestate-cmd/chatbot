/** Resultado de envíos de un handoff (cliente + comercial). */
export type LeadDeliveryChannels = {
  agent: { whatsapp: boolean | null; email: boolean | null };
  client: { whatsapp: boolean | null; email: boolean | null };
};

export type LeadDeliverySnapshot = LeadDeliveryChannels & {
  agentName?: string | null;
  ref?: string | null;
  clientChannel?: "whatsapp" | "email" | "none" | null;
  notes?: string | null;
};

export function emptyDelivery(): LeadDeliveryChannels {
  return {
    agent: { whatsapp: null, email: null },
    client: { whatsapp: null, email: null },
  };
}

export function resolveClientChannel(
  client: LeadDeliveryChannels["client"],
): "whatsapp" | "email" | "none" {
  if (client.whatsapp === true) return "whatsapp";
  if (client.email === true) return "email";
  return "none";
}

export type DesenlaceStep = {
  n: number;
  text: string;
  ok: boolean | null;
};

export type DesenlaceRow = {
  id: number;
  created_at: string;
  origin: string | null;
  intent: string | null;
  ref: string | null;
  summary: string | null;
  call_id: string | null;
  customer_phone: string;
  customer_name: string | null;
  customer_email: string | null;
  agent_name: string;
  agent_phone: string;
  agent_email_to: string | null;
  agent_wa: number | null;
  agent_email: number | null;
  client_wa: number | null;
  client_email: number | null;
  client_channel: string | null;
  notes: string | null;
  /** Mensaje enviado al comercial (texto del lead). */
  agent_message: string | null;
  /** Última respuesta al cliente en WhatsApp (si hay). */
  client_reply: string | null;
  /** true si solo hay lead histórico sin flags de canal */
  parcial: boolean;
  steps: DesenlaceStep[];
};

function tri(v: number | null | undefined): boolean | null {
  if (v == null) return null;
  return v === 1;
}

function originLabel(origin: string | null): string {
  const o = (origin ?? "").trim().toLowerCase();
  if (!o) return "contacto";
  if (o === "llamada" || o === "voice") return "llamada del cliente";
  if (o === "whatsapp" || o === "wa") return "WhatsApp del cliente";
  if (o === "email" || o.includes("email")) return "email del cliente";
  if (o.includes("idealista") || o.includes("fotocasa") || o.includes("pisos") || o.includes("habit")) {
    return `lead de portal (${origin})`;
  }
  return `origen ${origin}`;
}

/**
 * Timeline legible del handoff para el panel.
 */
export function buildDesenlaceSteps(row: {
  origin?: string | null;
  agent_name?: string | null;
  agent_wa?: number | null;
  agent_email?: number | null;
  client_wa?: number | null;
  client_email?: number | null;
  client_channel?: string | null;
  notes?: string | null;
  ref?: string | null;
}): { steps: DesenlaceStep[]; parcial: boolean } {
  const steps: DesenlaceStep[] = [];
  let n = 1;
  steps.push({
    n: n++,
    text: originLabel(row.origin ?? null),
    ok: true,
  });

  const hasAnyFlag =
    row.agent_wa != null ||
    row.agent_email != null ||
    row.client_wa != null ||
    row.client_email != null;

  const agent = row.agent_name?.trim() || "comercial";
  const refBit = row.ref ? ` (ref. ${row.ref})` : "";

  if (!hasAnyFlag) {
    steps.push({
      n: n++,
      text: `Lead registrado para ${agent}${refBit}. Sin detalle de canal (lead antiguo).`,
      ok: null,
    });
    if (row.notes?.trim()) {
      steps.push({ n: n++, text: row.notes.trim(), ok: null });
    }
    return { steps, parcial: true };
  }

  const cWa = tri(row.client_wa);
  const cEm = tri(row.client_email);
  if (cWa === true) {
    steps.push({
      n: n++,
      text: `WhatsApp al cliente con los datos de ${agent}${refBit}`,
      ok: true,
    });
  } else if (cEm === true) {
    steps.push({
      n: n++,
      text: `Email al cliente con los datos de ${agent}${refBit}`,
      ok: true,
    });
  } else if (cWa === false && cEm === false) {
    steps.push({
      n: n++,
      text: "No se pudo enviar al cliente (ni WhatsApp ni email)",
      ok: false,
    });
  } else if (cWa === false) {
    steps.push({
      n: n++,
      text: "WhatsApp al cliente falló" + (cEm == null ? " (email no intentado)" : ""),
      ok: false,
    });
  } else if (cEm === false) {
    steps.push({
      n: n++,
      text: "Email al cliente falló",
      ok: false,
    });
  } else if (row.client_channel === "none") {
    steps.push({
      n: n++,
      text: "Sin envío al cliente (sin teléfono/email válidos)",
      ok: null,
    });
  }

  const aWa = tri(row.agent_wa);
  const aEm = tri(row.agent_email);
  if (aWa === true) {
    steps.push({
      n: n++,
      text: `WhatsApp a ${agent} con los datos del cliente`,
      ok: true,
    });
  }
  if (aEm === true) {
    steps.push({
      n: n++,
      text: `Email a ${agent} con los datos del cliente`,
      ok: true,
    });
  }
  if (aWa === false && aEm !== true) {
    steps.push({
      n: n++,
      text: `WhatsApp a ${agent} falló` + (aEm === false ? " y el email también" : aEm == null ? "" : ""),
      ok: false,
    });
  } else if (aEm === false && aWa !== true) {
    steps.push({
      n: n++,
      text: `Email a ${agent} falló`,
      ok: false,
    });
  } else if (aWa == null && aEm == null) {
    steps.push({
      n: n++,
      text: `Aviso a ${agent} sin detalle de canal`,
      ok: null,
    });
  }

  if (row.notes?.trim()) {
    steps.push({ n: n++, text: row.notes.trim(), ok: null });
  }

  return { steps, parcial: false };
}

export function toDeliveryJson(snap: LeadDeliverySnapshot): Record<string, unknown> {
  return {
    agent: snap.agent,
    client: snap.client,
    agentName: snap.agentName ?? null,
    ref: snap.ref ?? null,
    clientChannel: snap.clientChannel ?? resolveClientChannel(snap.client),
    notes: snap.notes ?? null,
  };
}
