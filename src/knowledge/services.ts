/** Servicios oficiales de Inmobiliaria Bazán (conocimiento fijo, no depende del scrape). */

export const OWNER_SERVICES_ITEMS = [
  "Venta, alquiler o reforma de tu inmueble — nos encargamos de todo",
  "Con o sin exclusiva",
  "Tasación y valoración sin compromiso",
  "Tour 360 para visitar la casa online",
  "Sesión fotográfica profesional, plano a escala y vídeo",
  "Posicionamiento en portales inmobiliarios y acceso al mercado internacional",
  "Control de clientes solventes (ASNEF, CIRBE, RAI)",
  "Resolución de incidencias",
  "CRM de inversores de compra rápida y sin hipotecas",
] as const;

export const BUYER_SERVICES_ITEMS = [
  "Te ayudamos a encontrar inmueble en Málaga: compra, alquiler o inversión",
  "Gestión completa y asesoramiento legal",
  "Contratos elaborados por nuestros abogados",
  "Reformas y diseño de interiores",
  "Asesoramiento y gestión de hipotecas",
  "Tasación bancaria ajustada al precio de venta",
] as const;

/** Bloque inyectado siempre en el system prompt de Leo. */
export const BAZAN_SERVICES_PROMPT_BLOCK = [
  "--- Servicios Inmobiliaria Bazán (oficial) ---",
  "",
  "PROPIETARIOS (vender, alquilar o reformar su inmueble):",
  ...OWNER_SERVICES_ITEMS.map((s) => `- ${s}`),
  "",
  "COMPRADORES E INQUILINOS (buscan inmueble):",
  ...BUYER_SERVICES_ITEMS.map((s) => `- ${s}`),
  "",
  "Tienda: Calle Mármoles 39, Málaga. Redes sociales (+70k seguidores).",
  "Propietarios TIPO C: contacto Álvaro +34 646 424 563 y registro-vendedor.php.",
  "Responde con naturalidad y brevedad; no vuelques la lista entera salvo que pregunten por servicios o cómo trabajáis.",
  "--- Fin servicios ---",
].join("\n");

export function wantsOwnerServicesDetail(userText?: string | null): boolean {
  if (!userText?.trim()) return false;
  return /\b(c[oó]mo trabaj|c[oó]mo funciona|explic|proceso|gestion[aá]|servicios|qu[eé] ofrec|tour|tasaci|exclusiva|asnef|fotograf|portal|encarg[aá])/i.test(
    userText,
  );
}

export function wantsBuyerServicesDetail(userText?: string | null): boolean {
  if (!userText?.trim()) return false;
  return /\b(servicios|qu[eé] ofrec|hipoteca|reforma|interior|abogado|legal|tasaci[oó]n bancaria|gesti[oó]n completa)\b/i.test(
    userText,
  );
}

/** Resumen WhatsApp para propietarios (cuando piden detalle). */
export function formatOwnerServicesForWhatsApp(): string {
  return OWNER_SERVICES_ITEMS.map((s) => `• ${s}`).join("\n");
}

/** Resumen WhatsApp para compradores/inquilinos. */
export function formatBuyerServicesForWhatsApp(): string {
  return BUYER_SERVICES_ITEMS.map((s) => `• ${s}`).join("\n");
}
