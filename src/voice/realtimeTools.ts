import { config } from "../config.js";
import { searchProperties, type PropertyRow } from "../knowledge/properties.js";
import { publicPropertyUrl } from "../knowledge/propertyUrl.js";
import type { AgentContact } from "../agents/assignment.js";
import { formatLeadForAgent } from "../leads/agentNotification.js";
import { formatCustomerPropertyMessage } from "../whatsapp/customerPropertyMessage.js";
import {
  applyDeliveryChannels,
  hasRecentLeadNotification,
  insertLeadNotification,
  upsertLeadProfile,
} from "../db/leads.js";
import { tryClaimMetaDedup } from "../db/metaDedup.js";
import {
  emptyDelivery,
  resolveClientChannel,
  toDeliveryJson,
} from "../leads/delivery.js";
import { deliverAgentLeadNotification } from "../leads/notifyAgentDelivery.js";
import { trackAiAction } from "../panel/aiActions.js";
import { sendOutboundWhatsAppText, isProactiveWhatsAppAllowed } from "../whatsapp/outbound.js";
import {
  resolveVoiceClientPhone,
  sendVoiceClientPropertyEmail,
  sendVoiceClientWhatsAppConfirm,
  sendVoiceLeadEmails,
} from "./voiceLeadEmail.js";

export type VoiceIntent =
  | "comprar"
  | "alquilar"
  | "vender"
  | "alquiler_propietario"
  | "traspaso"
  | "visita"
  | "administrativo"
  | "alvaro";

const OWNER_INTENTS = new Set<VoiceIntent>(["vender", "alquiler_propietario", "traspaso"]);

function agentFromProperty(row: PropertyRow | null | undefined): AgentContact | null {
  if (!row?.agent_phone?.trim() || !row.agent_name?.trim()) return null;
  return { name: row.agent_name.trim(), phone: row.agent_phone.replace(/\D+/g, "") };
}

/** Comercial para voz: agente de la ficha si existe, si no el por defecto por intención. */
export function resolveVoiceAgent(intent: VoiceIntent, property?: PropertyRow | null): AgentContact {
  if (intent === "administrativo") {
    return {
      name: config.voiceAdminName || "Administrativo",
      phone: config.voiceAdminPhone.replace(/\D+/g, "") || "34672594724",
    };
  }
  // Pedir a Álvaro por nombre: siempre él (no el agente de una ficha).
  if (intent === "alvaro") {
    return {
      name: config.voiceOwnerAgentName,
      phone: config.voiceOwnerAgentPhone.replace(/\D+/g, "") || "34646424563",
    };
  }
  const fromProperty = agentFromProperty(property);
  if (fromProperty) return fromProperty;
  if (OWNER_INTENTS.has(intent)) {
    return { name: config.voiceOwnerAgentName, phone: config.voiceOwnerAgentPhone };
  }
  return { name: config.voiceBuyerAgentName, phone: config.voiceBuyerAgentPhone };
}

function priceEs(price: number | null): string | null {
  return price != null ? `${price.toLocaleString("es-ES")} euros` : null;
}

/** Resumen breve y apto para leer en voz alta (sin URLs largas). */
export function summarizePropertyForVoice(p: PropertyRow): string {
  const parts = [
    p.transaction_type ? p.transaction_type.toLowerCase() : null,
    priceEs(p.price),
    p.area_m2 != null ? `${p.area_m2} metros cuadrados` : null,
    p.bedrooms != null ? `${p.bedrooms} habitaciones` : null,
    p.bathrooms != null ? `${p.bathrooms} baños` : null,
    p.location ?? null,
  ].filter(Boolean);
  const head = `${p.title} (referencia ${p.ref})`;
  const desc = (p.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  return [head, parts.join(", "), desc].filter(Boolean).join(". ");
}

export type BuscarPropiedadInput = {
  ref?: string;
  transaction_type?: string;
  property_type?: string;
  location_contains?: string;
  max_price?: number;
  min_price?: number;
  min_bedrooms?: number;
  limit?: number;
};

export type BuscarPropiedadResult = {
  count: number;
  properties: Array<{
    ref: string;
    summary: string;
    url: string | null;
    transaction_type: string | null;
    price: number | null;
  }>;
};

/** Normaliza zona hablada: "calle Castilla" → "Castilla"; "Carlos de Haya" → "Carlos Haya". */
export function locationSearchVariants(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  const out: string[] = [t];
  const push = (s: string) => {
    const v = s.replace(/\s+/g, " ").trim();
    if (v.length >= 3 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  // Quita preposiciones "de/del" entre palabras (Carlos de Haya → Carlos Haya).
  push(t.replace(/\s+de(?:l)?\s+/gi, " "));

  // Quita prefijos de vía: calle / avda / plaza / barrio / zona…
  const noStreet = t
    .replace(
      /^(?:la\s+|el\s+|en\s+)?(?:calle|c\/|avda\.?|avenida|plaza|paseo|camino|carretera|barrio|zona|urbanizaci[oó]n)\s+(?:de\s+|del\s+|de\s+la\s+)?/i,
      ""
    )
    .trim();
  push(noStreet);
  push(noStreet.replace(/\s+de(?:l)?\s+/gi, " "));
  push(t.replace(/-/g, " "));
  push(t.replace(/\s+/g, "-"));

  const folded = t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\bvelez\b|\bbelen\b/.test(folded) || /belen\s+malaga/.test(folded)) {
    push("Vélez");
    push("Vélez-Málaga");
  }

  // Token significativo (última palabra ≥4 letras): "calle Castilla" → "Castilla".
  const tokens = noStreet
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4 && !/^(de|del|la|el|los|las|en|y)$/i.test(x));
  if (tokens.length >= 1) {
    push(tokens[tokens.length - 1]!);
    if (tokens.length >= 2) push(tokens.slice(-2).join(" "));
  }

  return out;
}

/** Holgura de precio (±10 %, mín. 100 €) para "unos 1400" vs ficha a 1350. */
export function withPriceMargin(
  maxPrice: number | undefined,
  minPrice: number | undefined
): { max_price?: number; min_price?: number } {
  const margin = (p: number) => Math.max(100, Math.round(p * 0.1));
  return {
    max_price: maxPrice != null ? maxPrice + margin(maxPrice) : undefined,
    min_price: minPrice != null ? Math.max(0, minPrice - margin(minPrice)) : undefined,
  };
}

function coerceOptionalNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(",", ".")))) {
    return Number(v.replace(",", "."));
  }
  return undefined;
}

export function toolBuscarPropiedad(input: BuscarPropiedadInput): BuscarPropiedadResult {
  const maxPrice = coerceOptionalNumber(input.max_price);
  const minPrice = coerceOptionalNumber(input.min_price);
  const minBedrooms = coerceOptionalNumber(input.min_bedrooms);
  const limit = Math.min(input.limit ?? 5, 8);
  const priced = withPriceMargin(maxPrice, minPrice);
  const base = {
    ref: input.ref ? String(input.ref).trim() : undefined,
    transaction_type: input.transaction_type,
    property_type: input.property_type,
    max_price: priced.max_price,
    min_price: priced.min_price,
    min_bedrooms: minBedrooms != null ? Math.round(minBedrooms) : undefined,
    limit,
    residential_only: !input.ref,
    exclude_shared_rooms: !input.ref,
  };

  const locVariants = locationSearchVariants(input.location_contains);
  const locationsToTry =
    locVariants.length > 0 ? locVariants : input.location_contains ? [input.location_contains] : [undefined];

  let rows: PropertyRow[] = [];
  for (const loc of locationsToTry) {
    rows = searchProperties({
      ...base,
      location_contains: loc,
    });
    if (rows.length > 0) break;
  }

  // Sin zona: si solo falló el precio estricto ya aplicamos margen en base.
  // Si con zona+margen no hay nada y había max_price, último intento sin techo de precio (misma zona).
  if (rows.length === 0 && !input.ref && maxPrice != null && locVariants.length > 0) {
    for (const loc of locVariants) {
      rows = searchProperties({
        ...base,
        max_price: undefined,
        location_contains: loc,
      });
      if (rows.length > 0) break;
    }
  }

  return {
    count: rows.length,
    properties: rows.map((p) => ({
      ref: p.ref,
      summary: summarizePropertyForVoice(p),
      url: p.url,
      transaction_type: p.transaction_type,
      price: p.price,
    })),
  };
}

export type DerivarComercialInput = {
  caller: string;
  intent: VoiceIntent;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  ref?: string | null;
  summary?: string | null;
  /** UUID de la sesión de voz; evita reenviar emails si el LLM llama dos veces. */
  callId?: string | null;
  /**
   * true = no esperar a emails/WhatsApp para responder. Durante una llamada real
   * esos envíos tardan segundos y el cliente solo oye silencio.
   */
  deferNotifications?: boolean;
};

export type DerivarComercialResult = {
  ok: boolean;
  duplicated?: boolean;
  agentName?: string;
  error?: string;
};

/**
 * Avisa al comercial (email/WA) y confirma al cliente.
 * Dedup por call_id (atómico) o, sin call_id, por lead reciente del mismo teléfono (1 h).
 */
export async function toolDerivarComercial(
  input: DerivarComercialInput
): Promise<DerivarComercialResult> {
  const callerDigits = resolveVoiceClientPhone(null, input.caller);
  if (!callerDigits) return { ok: false, error: "caller_required" };

  const ref = input.ref ? String(input.ref).trim() : null;
  const property = ref ? searchProperties({ ref, limit: 1 })[0] : undefined;
  const agent = resolveVoiceAgent(input.intent, property);

  const callId = input.callId?.trim() || null;
  if (callId) {
    const claimed = tryClaimMetaDedup(`voice_derivar:${callId}`);
    if (!claimed) {
      console.log("[voice/tools] derivar_comercial duplicado (misma llamada); no se reenvían emails", {
        callId,
        caller: callerDigits,
        agent: agent.name,
      });
      return { ok: true, duplicated: true, agentName: agent.name };
    }
  } else if (hasRecentLeadNotification(callerDigits, 1, ref)) {
    console.log("[voice/tools] derivar_comercial duplicado (lead reciente 1h); no se reenvían emails", {
      caller: callerDigits,
      ref,
      agent: agent.name,
    });
    return { ok: true, duplicated: true, agentName: agent.name };
  }

  const clientPhone = resolveVoiceClientPhone(input.phone, input.caller) || callerDigits;

  const summary = (input.summary ?? "").trim() || `Llamada de voz. Intención: ${input.intent}.`;
  const propertyUrl = publicPropertyUrl({ ref: ref ?? "", url: property?.url });

  const body = formatLeadForAgent({
    origin: "llamada",
    name: input.name ?? null,
    phone: clientPhone,
    email: input.email ?? null,
    ref,
    propertyUrl,
    clientInfo: summary,
  });

  // El lead se guarda antes de notificar: si luego falla un email, el aviso no se pierde.
  const leadId = insertLeadNotification({
    customerPhone: callerDigits,
    agentPhone: agent.phone,
    agentName: agent.name,
    ref,
    intent: input.intent,
    origin: "llamada",
    summary,
    callId,
    customerName: input.name ?? null,
    customerEmail: input.email ?? null,
  });

  upsertLeadProfile({
    customerPhone: callerDigits,
    name: input.name ?? null,
    email: input.email ?? null,
    intentType: input.intent,
    ref,
  });

  const deliverNotifications = async () => {
    const delivery = emptyDelivery();

    try {
      const notify = await deliverAgentLeadNotification(agent, body, { ref });
      delivery.agent.whatsapp = notify.whatsapp;
      delivery.agent.email = notify.email;
      if (!notify.whatsapp && !notify.email) {
        console.error("[voice/tools] Comercial sin aviso por WhatsApp ni email", {
          agent: agent.name,
          phone: agent.phone,
        });
      }
    } catch (e) {
      delivery.agent.whatsapp = false;
      delivery.agent.email = false;
      console.error("[voice/tools] No se pudo avisar al comercial", {
        agent: agent.name,
        error: e,
      });
    }

    // Email al comercial solo si notifyAgent no lo mandó ya (evita duplicar).
    // Con AGENT_NOTIFY_CHANNEL=both/email, deliverAgentLeadNotification ya lo envía.
    const emailResult = await sendVoiceLeadEmails({
      caller: callerDigits,
      intent: input.intent,
      name: input.name ?? null,
      phone: clientPhone,
      email: input.email ?? null,
      ref,
      summary,
      agent,
      property,
      skipAgentEmail: true,
    });
    delivery.client.email = emailResult.clientEmailSent
      ? true
      : input.email
        ? false
        : null;

    const clientWaOk = await sendVoiceClientWhatsAppConfirm({
      phone: clientPhone,
      name: input.name ?? null,
      agent,
      ref,
      summary,
      property,
    });
    delivery.client.whatsapp = clientWaOk
      ? true
      : config.voiceClientWhatsappConfirm
        ? false
        : null;

    // Si WA cliente falló y no hubo email, el email ya se intentó arriba cuando hay dirección.
    if (!clientWaOk && delivery.client.email !== true && input.email) {
      // ya reflejado en emailResult
    }

    applyDeliveryChannels(leadId, delivery, {
      customerName: input.name ?? null,
      customerEmail: input.email ?? null,
    });

    const agentOk = delivery.agent.whatsapp === true || delivery.agent.email === true;
    const clientOk = delivery.client.whatsapp === true || delivery.client.email === true;
    return {
      ...toDeliveryJson({
        ...delivery,
        agentName: agent.name,
        ref,
        clientChannel: resolveClientChannel(delivery.client),
      }),
      entregado: agentOk || clientOk,
    };
  };

  if (input.deferNotifications) {
    void trackAiAction(
      {
        source: "voice",
        channelId: callId,
        phone: callerDigits,
        tool: "derivar_comercial:envios",
        input: { agente: agent.name, intent: input.intent, ref },
      },
      async () => {
        const result = await deliverNotifications();
        if (!result.entregado) throw new Error("no se pudo notificar por ningún canal");
        return result;
      },
    ).catch(() => {
      // El fallo ya queda registrado en ai_actions y visible en el panel.
    });
    return { ok: true, agentName: agent.name };
  }

  const delivered = await deliverNotifications();
  if (!delivered.entregado) {
    return { ok: false, error: "notify_failed", agentName: agent.name };
  }

  return { ok: true, agentName: agent.name };
}

export type EnviarWhatsappClienteInput = {
  caller: string;
  ref?: string | null;
  text?: string | null;
};

export type EnviarWhatsappClienteResult = { ok: boolean; error?: string };

export type EnviarEmailClienteInput = {
  email: string;
  name?: string | null;
  ref?: string | null;
  text?: string | null;
  intent?: VoiceIntent;
};

export type EnviarEmailClienteResult = { ok: boolean; error?: string };

/** Envía al cliente (CLI de la llamada) la ficha o un texto por WhatsApp. */
export async function toolEnviarWhatsappCliente(
  input: EnviarWhatsappClienteInput
): Promise<EnviarWhatsappClienteResult> {
  if (!isProactiveWhatsAppAllowed()) {
    return { ok: false, error: "proactive_whatsapp_disabled" };
  }

  const to = (input.caller ?? "").replace(/\D+/g, "");
  if (!to) return { ok: false, error: "caller_required" };

  const ref = input.ref ? String(input.ref).trim() : null;
  let body = (input.text ?? "").trim();

  if (!body && ref) {
    const property = searchProperties({ ref, limit: 1 })[0];
    if (property) {
      const agent = agentFromProperty(property) ?? {
        name: config.voiceBuyerAgentName,
        phone: config.voiceBuyerAgentPhone,
      };
      body = formatCustomerPropertyMessage({
        property,
        agent,
        leadOrigin: "voice",
        withClosing: true,
      });
    }
  }

  if (!body) return { ok: false, error: "nothing_to_send" };

  try {
    await sendOutboundWhatsAppText(to, body, config.evolutionInstance || undefined);
    return { ok: true };
  } catch (e) {
    console.error("[voice/tools] No se pudo enviar WhatsApp al cliente", { toPrefix: to.slice(0, 6), error: e });
    return { ok: false, error: "send_failed" };
  }
}

/** Envía al cliente la ficha o un texto por email (p. ej. tras llamada Retell). */
export async function toolEnviarEmailCliente(
  input: EnviarEmailClienteInput,
): Promise<EnviarEmailClienteResult> {
  const ref = input.ref ? String(input.ref).trim() : null;
  const property = ref ? searchProperties({ ref, limit: 1 })[0] : undefined;
  const agent = resolveVoiceAgent(input.intent ?? "comprar", property);

  return sendVoiceClientPropertyEmail({
    email: input.email,
    name: input.name ?? null,
    ref,
    text: input.text ?? null,
    agent,
  });
}
