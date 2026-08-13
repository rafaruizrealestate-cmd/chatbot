/** Temas de administración (oficina): no generan lead al comercial. */
import { config } from "../config.js";
import { formatPhoneForDisplay } from "../utils/phone.js";
import { OFFICE_HOURS_LABEL } from "../utils/workSchedule.js";

function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasAdministrativeSignals(text: string): boolean {
  const t = norm(text);
  // Nombre antiguo (por si el cliente lo menciona); la respuesta ya no usa ese nombre.
  if (/\bmariana\b/.test(t)) return true;
  if (/\bangela\b/.test(t)) return true;
  if (/\badministrativ[oa]s?\b/.test(t)) return true;
  if (/\bsecretari[oa]s?\b/.test(t)) return true;
  if (/\b(departamento|gesti[oó]n)\s+de\s+administraci[oó]n\b/.test(t)) return true;
  if (/\bfianza\b/.test(t) && /\b(devoluci|entrega|recuper|mi fianza)\b/.test(t)) return true;
  if (/\b(contrato|contratos)\s+(de\s+)?(alquiler|arrendamiento)\b/.test(t)) return true;
  if (/\b(contrato|contratos)\s+(vigente|actual|firmado)\b/.test(t)) return true;
  if (/\b(incidencia|aver[ií]a|reparaci[oó]n|gotera|fontaner[ií]a)\b/.test(t) && /\b(mi|nuestro|el)\s+(piso|vivienda|inmueble|alquiler)\b/.test(t)) return true;
  if (/\brecibo(s)?\s+(de\s+)?(alquiler|renta)\b/.test(t)) return true;
  if (/\bcomunidad\s+de\s+propietarios\b/.test(t)) return true;
  if (/\b(y|soy|somos)\s+(inquilino|arrendatario|propietario)\s+actual\b/.test(t)) return true;
  if (/\b(habl[eé]|hablaba|escrib[ií])\s+con\s+mariana\b/.test(t)) return true;
  if (/\b(con|de)\s+la\s+administraci[oó]n\b/.test(t)) return true;
  if (/\b(actualizaci[oó]n|renovaci[oó]n)\s+del\s+contrato\b/.test(t)) return true;
  if (/\bseguro\s+de\s+(hogar|alquiler|impago)\b/.test(t) && /\b(contrato|p[oó]liza)\b/.test(t)) return true;
  return false;
}

/** Lead nuevo claro en el mensaje actual: no tratar como administración. */
function hasStrongNewLeadIntent(currentText: string): boolean {
  const t = norm(currentText);
  if (/\b(busco|buscando|me interesa|quiero\s+(alquilar|comprar|ver|visitar))\s+(un\s+)?(piso|inmueble|chalet|atico|[aá]tico|estudio)\b/.test(t)) {
    return true;
  }
  if (/\b(ref(?:erencia)?\s*[:#]?\s*\d{3,4})\b/.test(t) && /\b(interesad|informaci|visita|alquiler|comprar)\b/.test(t)) {
    return true;
  }
  if (/\b(ponme en contacto|hablar con (un )?(comercial|agente))\b/.test(t)) return true;
  if (/\bnuevo\s+(lead|inter[eé]s|contacto)\b/.test(t)) return true;
  return false;
}

/**
 * Conversación sobre gestión/administración de un caso ya existente,
 * no un lead comercial nuevo.
 */
export function isAdministrativeConversation(
  currentText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): boolean {
  if (hasStrongNewLeadIntent(currentText)) return false;

  const histText = history.map((m) => m.content).join("\n");
  const combined = `${histText}\n${currentText}`;

  if (hasAdministrativeSignals(currentText)) return true;

  // Historial con administración y el cliente sigue en el mismo hilo sin lead nuevo claro.
  if (history.length >= 2 && hasAdministrativeSignals(histText)) return true;

  return hasAdministrativeSignals(combined) && history.length >= 4;
}

export const ADMINISTRATIVE_OFFICE_HINT =
  `Para temas administrativos (contrato, fianza, incidencias…), escribe aquí mismo en horario de oficina, ${OFFICE_HOURS_LABEL}. ${config.voiceAdminName} se encargará y te atenderá por este mismo WhatsApp. Si es urgente, puedes llamarla al ${formatPhoneForDisplay(config.voiceAdminPhone)} dentro de ese horario.`;

/** @deprecated usar ADMINISTRATIVE_OFFICE_HINT */
export const ADMINISTRATIVE_MARIANA_HINT = ADMINISTRATIVE_OFFICE_HINT;
