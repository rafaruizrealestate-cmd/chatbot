import type { AgentContact } from "../agents/assignment.js";
import { formatAgentPhoneEs } from "../leads/agentNotification.js";
import type { PropertyRow } from "../knowledge/properties.js";
import { isGarbageClientName } from "../utils/portalLeadText.js";

/** Cierre suave: invita a seguir, no despide ni da por terminada la conversación. */
export const CUSTOMER_PROPERTY_CLOSING =
  "Si te surge alguna duda sobre el inmueble, escríbeme por aquí.";

/** Etiqueta legible del origen del contacto para el cliente. */
export function formatLeadOriginForCustomer(origin: string | null | undefined): string {
  const o = (origin ?? "").trim().toLowerCase();
  if (!o) return "la web de Inmobiliaria Bazán";
  if (o.includes("idealista")) return "Idealista";
  if (o.includes("fotocasa")) return "Fotocasa";
  if (o.includes("pisos")) return "Pisos.com";
  if (o.includes("indomio")) return "Indomio";
  if (o.includes("habitatsoft")) return "HabitatSoft";
  if (o.includes("inmobiliariabazan") || o === "web" || o.includes("webbazan")) {
    return "la web de Inmobiliaria Bazán (inmobiliariabazan.com)";
  }
  if (o === "llamada" || o === "voice") return "una llamada telefónica a Inmobiliaria Bazán";
  if (o === "whatsapp") return "WhatsApp";
  if (o === "email" || o === "correo") return "correo electrónico";
  return o.charAt(0).toUpperCase() + o.slice(1);
}

function formatPrice(price: number): string {
  return `${price.toLocaleString("es-ES")} €`;
}

export type CustomerPropertyMessageOpts = {
  property: PropertyRow;
  agent?: AgentContact | null;
  customerName?: string | null;
  leadOrigin?: string | null;
  /** Si true, añade el cierre (email: un solo mensaje). */
  withClosing?: boolean;
  /**
   * Estilo de la línea del comercial.
   * - direct: tono WhatsApp / llamada corta
   * - visit: tono email Leo (portal): comercial + visita
   * Por defecto: visit en email (withClosing) o portal; direct en canales directos.
   */
  agentLineStyle?: "direct" | "visit";
};

/** Mensaje al cliente: saludo, origen portal, ficha, comercial (desde scrape). */
export function formatCustomerPropertyMessage(opts: CustomerPropertyMessageOpts): string {
  const { property: p, agent, customerName, leadOrigin, withClosing } = opts;

  const name = customerName?.trim();
  const greeting =
    name && !isGarbageClientName(name) ? `Hola ${name},` : "Hola,";

  const originLabel = formatLeadOriginForCustomer(leadOrigin);
  const o = (leadOrigin ?? "").trim().toLowerCase();
  const isDirectChannel = o === "whatsapp" || o === "voice" || o === "llamada";
  const intro = isDirectChannel
    ? "Te paso la ficha que encaja con lo que me comentas:"
    : `Hemos recibido un contacto suyo desde el portal inmobiliario ${originLabel}.`;

  const specs = [
    p.price != null ? formatPrice(p.price) : null,
    p.area_m2 != null ? `${p.area_m2} m²` : null,
    p.bedrooms != null ? `${p.bedrooms} hab.` : null,
    p.location ?? null,
  ]
    .filter(Boolean)
    .join(", ");

  const url =
    (p.url?.trim() || null) ??
    `https://www.inmobiliariabazan.com/propiedad?propiedad=${encodeURIComponent(p.ref)}`;

  const lines = [greeting, "", intro, "", `${p.title} (ref. ${p.ref}): ${specs}.`, url];

  if (agent?.name?.trim() && agent.phone?.trim()) {
    const style =
      opts.agentLineStyle ??
      (withClosing || !isDirectChannel ? "visit" : "direct");
    const agentLine =
      style === "visit"
        ? `Tu comercial es ${agent.name.trim()}, Telf: ${formatAgentPhoneEs(agent.phone)}. Por favor contáctale por su WhatsApp o, si prefieres, llámalo, para coordinar una visita.`
        : `Si quieres visitarla o tienes dudas, ${agent.name.trim()} (WhatsApp ${formatAgentPhoneEs(agent.phone)}) te ayuda con gusto.`;
    lines.push("", agentLine);
  }

  if (withClosing) {
    lines.push("", CUSTOMER_PROPERTY_CLOSING);
  }

  return lines.join("\n");
}
