/** IDs de tracking Idealista / portales que no son referencia de ficha Bazán. */
const BLOCKED_REFS = new Set(["582065"]);

/** Quita URLs y parámetros de tracking antes de buscar referencias. */
export function scrubRefSourceText(text: string): string {
  return text
    .replace(/https?:\/\/col\.idealista\.com\/[^\s)>\]]+/gi, " ")
    .replace(/https?:\/\/email\.return\.idealista\.com\/[^\s)>\]]+/gi, " ")
    .replace(/\bs=\d{3,10}\b/gi, " ")
    .replace(/\bevents=\[[^\]]+\]/gi, " ")
    .replace(/c[oó]digo\s+del\s+anuncio[:\s]+\d+/gi, " ");
}

/** Valida referencia de inmueble (3–4 dígitos; excluye años y tracking). */
export function sanitizePropertyRef(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const r = raw.trim();
  if (!/^\d{3,4}$/.test(r)) return null;
  if (BLOCKED_REFS.has(r)) return null;
  const n = Number.parseInt(r, 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 1900 && n <= 2099) return null;
  if (n < 100) return null;
  return r;
}

/** Ref en catálogo: Bazán 3–4 dígitos o ID de anuncio Idealista (6–12). */
export function catalogPropertyRef(raw: string | null | undefined): string | null {
  const short = sanitizePropertyRef(raw);
  if (short) return short;
  const r = raw?.trim() ?? "";
  if (/^\d{6,12}$/.test(r)) return r;
  return null;
}

function normalizeSpoken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,;:!?¡¿"'«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SPOKEN_UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};

const SPOKEN_TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};

const SPOKEN_HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  // Typos frecuentes al escribir en WhatsApp
  sesiscientos: 600,
  seisicientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
};

const FILLER = new Set(["y", "la", "el", "de", "del", "es", "a"]);

function tokenizeSpoken(text: string): string[] {
  return normalizeSpoken(text)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((tok) => (tok.includes("-") ? tok.split("-").filter(Boolean) : [tok]));
}

/** Parsea un tramo en español a un entero (0–9999), o null. */
export function parseSpanishNumberPhrase(tokens: string[]): number | null {
  if (!tokens.length) return null;
  let i = 0;
  let total = 0;
  let current = 0;
  let sawNumber = false;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (FILLER.has(t)) {
      i += 1;
      continue;
    }
    if (t === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      sawNumber = true;
      i += 1;
      continue;
    }
    if (SPOKEN_HUNDREDS[t] != null) {
      current += SPOKEN_HUNDREDS[t]!;
      sawNumber = true;
      i += 1;
      continue;
    }
    if (SPOKEN_TENS[t] != null) {
      current += SPOKEN_TENS[t]!;
      sawNumber = true;
      i += 1;
      continue;
    }
    if (SPOKEN_UNITS[t] != null) {
      current += SPOKEN_UNITS[t]!;
      sawNumber = true;
      i += 1;
      continue;
    }
    return null;
  }

  if (!sawNumber) return null;
  return total + current;
}

/**
 * Interpreta refs dichas en español (cualquier ref 3–4 dígitos, p. ej. 1652):
 * - "uno seis cinco dos" → 1652
 * - "dieciséis cincuenta y dos" → 1652
 * - "dieciséis dieciséis" → 1616
 * - "mil seiscientos cincuenta y dos" → 1652
 */
export function parseSpokenPropertyRef(text: string): string | null {
  const raw = tokenizeSpoken(text);
  const meaningful = raw.filter((t) => !FILLER.has(t));
  if (!meaningful.length) return null;

  // 1) Dígito a dígito: "uno seis cinco dos"
  if (
    meaningful.length >= 3 &&
    meaningful.length <= 4 &&
    meaningful.every((t) => SPOKEN_UNITS[t] != null && SPOKEN_UNITS[t]! <= 9)
  ) {
    return sanitizePropertyRef(meaningful.map((t) => String(SPOKEN_UNITS[t]!)).join(""));
  }

  // 2) Dos grupos ≤99: "dieciseis cincuenta y dos", "dieciseis dieciseis"
  //    (antes del número completo: "dieciseis dieciseis" no debe sumar 32).
  const meaningfulIdx = raw
    .map((t, idx) => (FILLER.has(t) ? -1 : idx))
    .filter((idx) => idx >= 0);
  for (let k = 1; k < meaningfulIdx.length; k++) {
    const splitAt = meaningfulIdx[k]!;
    const left = raw.slice(0, splitAt);
    const right = raw.slice(splitAt);
    // No partir "cincuenta y dos" en 50 | y dos
    const leftLast = [...left].reverse().find((t) => !FILLER.has(t));
    if (
      leftLast &&
      SPOKEN_TENS[leftLast] != null &&
      right[0] === "y" &&
      right.some((t) => SPOKEN_UNITS[t] != null && SPOKEN_UNITS[t]! <= 9)
    ) {
      continue;
    }
    while (left.length && FILLER.has(left[left.length - 1]!)) left.pop();
    const n1 = parseSpanishNumberPhrase(left);
    const n2 = parseSpanishNumberPhrase(right);
    if (
      n1 != null &&
      n2 != null &&
      n1 >= 0 &&
      n1 <= 99 &&
      n2 >= 0 &&
      n2 <= 99
    ) {
      const digits = `${String(n1).padStart(2, "0")}${String(n2).padStart(2, "0")}`;
      const ref = sanitizePropertyRef(digits);
      if (ref) return ref;
    }
  }

  // 3) Número completo: "mil seiscientos cincuenta y dos"
  const full = parseSpanishNumberPhrase(raw);
  if (full != null) return sanitizePropertyRef(String(full));

  return null;
}

function stripRefLeadIn(text: string): string {
  return text
    .replace(
      /^(?:hola[,.]?\s+)?(?:la\s+)?(?:ref\.?|referencia)\s*(?:es\s*(?:la|el)?|del?\s+inmueble|de\s+la\s+ficha)?\s*[:#-]?\s*/i,
      "",
    )
    .trim();
}

/**
 * Si el mensaje es solo (o casi solo) una referencia: "1652", "ref 1652",
 * "dieciséis cincuenta y dos", "uno seis cinco dos", "Las Palmas 1616".
 */
export function extractBarePropertyRef(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 80) return null;

  const m = t.match(/^(?:la\s+)?(?:ref\.?|referencia)?\s*[:#-]?\s*(\d{3,4})\s*\.?$/i);
  if (m?.[1]) return sanitizePropertyRef(m[1]);

  const stripped = stripRefLeadIn(t);
  if (/^\d{3,4}\s*\.?$/.test(stripped)) return sanitizePropertyRef(stripped.replace(/\D/g, ""));

  // "Las Palmas 1616", "chalet Mijas 1616" — número al final, sin contexto de precio.
  if (!/\b(presupuesto|euros?|€|eur\b|\/\s*mes|al\s+mes)\b/i.test(t)) {
    const trailing = t.match(/\b(\d{3,4})\s*[.!?]?\s*$/);
    if (trailing?.[1]) {
      const ref = sanitizePropertyRef(trailing[1]);
      if (ref) return ref;
    }
  }

  if (/[a-záéíóúñ]/i.test(stripped) && stripped.length <= 80) {
    return parseSpokenPropertyRef(stripped);
  }
  return null;
}

/**
 * Candidatos numéricos 3–4 dígitos (sanitizados). El catálogo scrapeado
 * decide cuál es ficha real; aquí solo listamos sin inventar comerciales.
 */
export function extractAllPropertyRefCandidates(text: string): string[] {
  const scrubbed = scrubRefSourceText(text);
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (raw: string | null | undefined) => {
    const ref = sanitizePropertyRef(raw);
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };

  // Explícitos primero (mismo orden que extractPropertyRefFromText).
  const urlMatch =
    scrubbed.match(/inmobiliariabazan\.com\/[^\s]*[?&]propiedad=(\d{3,4})\b/i) ??
    scrubbed.match(/propiedad\?propiedad=(\d{3,4})\b/i) ??
    scrubbed.match(/\/propiedad\/(\d{3,4})\b/i);
  if (urlMatch?.[1]) push(urlMatch[1]);

  for (const p of [
    /\bref\.?\s*[:#-]?\s*(\d{3,4})\b/gi,
    /\breferencia\b(?:\s+(?:es|del?\s+inmueble|de\s+la\s+ficha))?\s*(?:la|el|las|los)?\s*[:#-]?\s*(\d{3,4})\b/gi,
  ]) {
    for (const m of scrubbed.matchAll(p)) push(m[1]);
  }

  for (const m of scrubbed.matchAll(/\b(\d{3,4})\b/g)) {
    const idx = m.index ?? 0;
    const window = scrubbed.slice(Math.max(0, idx - 28), Math.min(scrubbed.length, idx + m[0].length + 28));
    // Evitar precios/presupuestos sueltos; el cruce con BD filtra el resto.
    if (
      /\b(presupuesto|€|euros?\b|eur\b|\/\s*mes|al\s+mes)\b/i.test(window) &&
      !/\b(ref\.?|referencia|ficha|propiedad)\b/i.test(window)
    ) {
      continue;
    }
    push(m[1]);
  }

  const bare = extractBarePropertyRef(scrubbed);
  if (bare) push(bare);

  return out;
}

/** Extrae la referencia de ficha desde texto de email/mensaje. */
export function extractPropertyRefFromText(text: string): string | null {
  const scrubbed = scrubRefSourceText(text);

  const urlMatch =
    scrubbed.match(/inmobiliariabazan\.com\/[^\s]*[?&]propiedad=(\d{3,4})\b/i) ??
    scrubbed.match(/propiedad\?propiedad=(\d{3,4})\b/i) ??
    scrubbed.match(/\/propiedad\/(\d{3,4})\b/i);
  if (urlMatch?.[1]) {
    const fromUrl = sanitizePropertyRef(urlMatch[1]);
    if (fromUrl) return fromUrl;
  }

  const patterns = [
    /\bref\.?\s*[:#-]?\s*(\d{3,4})\b/i,
    /\bref:\s*(\d{3,4})\b/i,
    /\bcon\s+ref[:\s]+(\d{3,4})\b/i,
    /\bcon\s+referencia\s+(\d{3,4})\b/i,
    // "la referencia es la 1616" / "la referencia es las 1616"
    /\breferencia\b(?:\s+(?:es|del?\s+inmueble|de\s+la\s+ficha))?\s*(?:la|el|las|los)?\s*[:#-]?\s*(\d{3,4})\b/i,
    /\breferencia\b\s*[:#-]?\s*(\d{3,4})\b/i,
    /\binmueble\s+con\s+referencia\s+(\d{3,4})\b/i,
  ];
  for (const p of patterns) {
    const m = scrubbed.match(p);
    if (m?.[1]) {
      const ref = sanitizePropertyRef(m[1]);
      if (ref) return ref;
    }
  }

  // "la referencia es dieciséis cincuenta y dos"
  const spokenAfterRef = scrubbed.match(
    /\breferencia\b(?:\s+(?:es|del?\s+inmueble|de\s+la\s+ficha))?\s*(?:la|el)?\s*[:#-]?\s*([a-záéíóúñü\s-]{6,80})/i,
  );
  if (spokenAfterRef?.[1]) {
    const spoken = parseSpokenPropertyRef(spokenAfterRef[1]);
    if (spoken) return spoken;
  }

  return extractBarePropertyRef(scrubbed);
}
