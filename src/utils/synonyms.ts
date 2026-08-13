function normalizeBase(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Normaliza sinónimos frecuentes para mejorar clasificación y búsquedas.
 * No pretende reescribir el mensaje completo; solo reduce variaciones.
 */
export function normalizeRealEstateSynonyms(input: string): string {
  if (!input.trim()) return input;

  // Operamos sobre una copia pero preservando el texto original lo máximo posible.
  // Para sustituciones fiables, trabajamos con una versión normalizada y aplicamos cambios simples en original.
  const t = normalizeBase(input);
  let out = input;

  const replaceWord = (pattern: RegExp, replacement: string) => {
    out = out.replace(pattern, replacement);
  };

  // Terreno / parcela / solar
  if (/\b(solar|terreno|terrenito|parcela|finca rustica|finca rústica)\b/i.test(t)) {
    replaceWord(/\bsolar(es)?\b/gi, "parcela");
    replaceWord(/\bterreno(s)?\b/gi, "parcela");
  }

  // Piso / apartamento / departamento
  if (/\b(piso|apartamento|depto|departamento)\b/i.test(t)) {
    replaceWord(/\bdepartamento(s)?\b/gi, "piso");
    replaceWord(/\bdepto(s)?\b/gi, "piso");
    replaceWord(/\bapartamento(s)?\b/gi, "piso");
  }

  return out;
}

