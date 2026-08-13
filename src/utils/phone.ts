const BLOCKED_CORPORATE_PHONES = new Set([
  "34672594724",
  "34851813840",
  /** Atención al cliente Fotocasa Pro (pie de email, no es del interesado). */
  "34900823825",
]);

export function isBlockedCorporatePhone(digits: string): boolean {
  const d = digits.replace(/\D+/g, "");
  return BLOCKED_CORPORATE_PHONES.has(d);
}

/**
 * Convierte un fragmento de teléfono (p. ej. de `[tel:+33…]`, «Teléfono: …») a dígitos E.164 sin «+».
 * Respeta el prefijo internacional cuando viene explícito (+CC o 00CC). Solo asume España (34) si
 * el número es claramente español (9 dígitos 6/7XX o prefijo +34/0034/34).
 */
export function parsePhoneToE164Digits(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes("+")) {
    const plusBody = trimmed.match(/\+\s*([\d\s().-]+)/)?.[1];
    if (plusBody) {
      const all = plusBody.replace(/\D+/g, "");
      const fromPlus = parseE164FromPlusDigits(all);
      if (fromPlus && isValidE164Length(fromPlus) && !isBlockedCorporatePhone(fromPlus)) {
        return fromPlus;
      }
    }
  }

  const intl00 = trimmed.match(/\b00(\d{1,3})[\s().-]*((?:\d[\s().-]*){6,14}\d)/);
  if (intl00?.[1] && intl00?.[2]) {
    const digits = normalizeExplicitCountryDigits(intl00[1], intl00[2]);
    if (digits && isValidE164Length(digits) && !isBlockedCorporatePhone(digits)) return digits;
  }

  const hasForeignPrefix = /\+\s*(?!34\b)\d{1,3}/.test(trimmed) || /\b00(?!34\b)\d{1,3}/.test(trimmed);
  if (hasForeignPrefix) return null;

  const esExplicit = trimmed.match(
    /(?:\+34|0034|34)[\s.-]?(6\d{2}|7[1-9]\d)[\s.\-]?(\d{3})[\s.\-]?(\d{3})/
  );
  if (esExplicit) {
    const digits = `34${esExplicit[1]}${esExplicit[2]}${esExplicit[3]}`.replace(/\D+/g, "");
    if (!isBlockedCorporatePhone(digits)) return digits;
  }

  if (!trimmed.includes("+") && !/\b00\d{1,3}/.test(trimmed)) {
    const esLocal = trimmed.match(/(?:^|[^\d+])(6\d{2}|7[1-9]\d)[\s.\-]?(\d{3})[\s.\-]?(\d{3})(?!\d)/);
    if (esLocal) {
      const digits = `34${esLocal[1]}${esLocal[2]}${esLocal[3]}`.replace(/\D+/g, "");
      if (!isBlockedCorporatePhone(digits)) return digits;
    }

    const bare = trimmed.replace(/\D+/g, "");
    if (bare.length === 9 && /^[67]/.test(bare)) {
      const digits = `34${bare}`;
      if (!isBlockedCorporatePhone(digits)) return digits;
    }
    if (bare.length >= 11 && bare.length <= 15 && !isBlockedCorporatePhone(bare)) {
      return bare;
    }
  }

  return null;
}

/** Dígitos tras el «+» ya concatenados (sin ambigüedad 340 vs 34). */
function parseE164FromPlusDigits(all: string): string | null {
  if (all.length < 8 || all.length > 15) return null;

  if (all.startsWith("34")) {
    const national = all.slice(2);
    if (national.startsWith("0")) {
      return national.replace(/^0+/, "") || national;
    }
    return `34${national}`;
  }

  return all;
}

function normalizeExplicitCountryDigits(cc: string, nationalPart: string): string {
  let national = nationalPart.replace(/\D+/g, "");
  // Fotocasa a veces envía [tel:+340657727867] para un móvil extranjero con 0 local — no es +34.
  if (cc === "34" && national.startsWith("0")) {
    return national.replace(/^0+/, "") || national;
  }
  return `${cc}${national}`;
}

function isValidE164Length(digits: string): boolean {
  return digits.length >= 8 && digits.length <= 15;
}

const INTL_PLUS_RE = /\+\s*[\d\s().-]{8,24}\d/g;
const INTL_00_RE = /\b00\d{1,3}[\s().-]*(?:\d[\s().-]*){6,14}\d/g;
const ES_MOBILE_RE =
  /(?:\+34|0034|34)?[\s.-]?(6\d{2}|7[1-9]\d)[\s.\-]?(\d{3})[\s.\-]?(\d{3})/g;

/** Busca el primer teléfono válido en un bloque de texto (email, chat). */
export function extractPhoneFromText(text: string): string | null {
  for (const m of text.matchAll(INTL_PLUS_RE)) {
    const digits = parsePhoneToE164Digits(m[0]);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }

  for (const m of text.matchAll(INTL_00_RE)) {
    const digits = parsePhoneToE164Digits(m[0]);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }

  for (const m of text.matchAll(ES_MOBILE_RE)) {
    const digits = parsePhoneToE164Digits(m[0]);
    if (digits && !isBlockedCorporatePhone(digits)) return digits;
  }

  return null;
}

/** Formato legible para agentes; no cambia el país de origen. */
export function formatPhoneForDisplay(digits: string): string {
  const d = digits.replace(/\D+/g, "");
  if (!d) return digits;

  if (d.startsWith("34") && d.length === 11) {
    const r = d.slice(2);
    return `+34 ${r.slice(0, 3)} ${r.slice(3, 6)} ${r.slice(6)}`.trim();
  }

  if (d.startsWith("33") && d.length === 11) {
    const r = d.slice(2);
    return `+33 ${r[0]} ${r.slice(1, 3)} ${r.slice(3, 5)} ${r.slice(5, 7)} ${r.slice(7)}`.trim();
  }

  if (d.startsWith("49") && d.length >= 12) {
    const r = d.slice(2);
    return `+49 ${r.slice(0, 3)} ${r.slice(3)}`.trim();
  }

  if (d.startsWith("31") && d.length === 11) {
    const r = d.slice(2);
    return `+31 ${r.slice(0, 1)} ${r.slice(1)}`.trim();
  }

  return `+${d}`;
}
