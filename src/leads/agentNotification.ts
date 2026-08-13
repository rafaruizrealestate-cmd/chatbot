import { formatPhoneForDisplay } from "../utils/phone.js";

export function formatAgentPhoneEs(digits: string): string {
  return formatPhoneForDisplay(digits);
}

export type AgentLeadNotification = {
  /** idealista, fotocasa, whatsapp, habitatsoft, email, etc. */
  origin: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  ref?: string | null;
  propertyUrl?: string | null;
  /** Texto o datos que el cliente ha facilitado (chat o cuerpo del email). */
  clientInfo?: string | null;
};

const NO_PROPORCIONADO = "No proporcionado";

function field(value: string | null | undefined): string {
  const v = value?.trim();
  return v ? v : NO_PROPORCIONADO;
}

/** Aviso al WhatsApp del agente. */
export function formatLeadForAgent(input: AgentLeadNotification): string {
  const origin = (input.origin ?? "otro").trim().toLowerCase();
  const phone = input.phone?.trim() ? formatAgentPhoneEs(input.phone.trim()) : null;

  return [
    "Tienes un nuevo Lead.",
    `nombre: ${field(input.name)}`,
    `tel: ${field(phone)}`,
    `email: ${field(input.email)}`,
    `origen: ${field(origin)}`,
    `ref: ${field(input.ref)}`,
    `url: ${field(input.propertyUrl)}`,
    `mensaje del cliente: ${field(input.clientInfo)}`,
  ].join("\n");
}
