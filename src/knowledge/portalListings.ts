import { getDb } from "../db/database.js";
import { catalogPropertyRef, sanitizePropertyRef } from "../utils/propertyRef.js";

export type PortalListingOrigin = "idealista" | "fotocasa" | "pisos" | "indomio" | "habitaclia" | "milanuncios";

/** IDs de anuncio en portales → referencia interna Bazán. */
const SEED: Array<{ portal: PortalListingOrigin; externalId: string; propertyRef: string }> = [
  { portal: "idealista", externalId: "111835353", propertyRef: "1736" },
  { portal: "fotocasa", externalId: "190290228", propertyRef: "1759" },
  // pisos.com: ...-65866607613_104700/  (id anuncio_oficina)
  { portal: "pisos", externalId: "65866607613_104700", propertyRef: "1759" },
  { portal: "pisos", externalId: "65866607613", propertyRef: "1759" },
];

let seeded = false;

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_listings (
      portal TEXT NOT NULL,
      external_id TEXT NOT NULL,
      property_ref TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (portal, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_portal_listings_ref
      ON portal_listings(property_ref);
  `);
  if (seeded) return;
  seeded = true;
  for (const row of SEED) {
    rememberPortalListing(row.portal, row.externalId, row.propertyRef);
  }
}

function isPlausibleExternalId(portal: string, id: string): boolean {
  // Refs internas Bazán son 3–4 dígitos; los IDs de portal suelen ser ≥6.
  if (portal === "pisos") return /^\d{6,14}(?:_\d{3,8})?$/.test(id);
  if (!/^\d{6,14}$/.test(id)) return false;
  if (portal === "fotocasa" || portal === "idealista") return id.length >= 6;
  return true;
}

export function rememberPortalListing(
  portal: string,
  externalId: string,
  propertyRef: string | null | undefined
): void {
  const ref = catalogPropertyRef(propertyRef);
  const id = externalId.trim();
  const p = portal.trim().toLowerCase();
  if (!ref || !id || !p) return;
  if (!isPlausibleExternalId(p, id)) return;
  ensureTable();
  getDb()
    .prepare(
      `INSERT INTO portal_listings (portal, external_id, property_ref, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(portal, external_id) DO UPDATE SET
         property_ref = excluded.property_ref,
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(p, id, ref);
}

export function lookupPortalListing(portal: string, externalId: string): string | null {
  ensureTable();
  const id = externalId.trim();
  const p = portal.trim().toLowerCase();
  const row = getDb()
    .prepare(
      `SELECT property_ref AS ref FROM portal_listings
       WHERE portal = ? AND external_id = ? LIMIT 1`
    )
    .get(p, id) as { ref?: string } | undefined;
  const direct = catalogPropertyRef(row?.ref);
  if (direct) return direct;
  // pisos.com a veces se indexa solo con el id largo sin sufijo _oficina
  if (p === "pisos" && id.includes("_")) {
    const base = id.split("_")[0]!;
    const row2 = getDb()
      .prepare(
        `SELECT property_ref AS ref FROM portal_listings
         WHERE portal = ? AND external_id = ? LIMIT 1`
      )
      .get(p, base) as { ref?: string } | undefined;
    return catalogPropertyRef(row2?.ref) ?? null;
  }
  return null;
}

/** Detecta portal + id de anuncio en URL o texto. */
export function extractPortalAdRef(text: string): { portal: PortalListingOrigin; externalId: string } | null {
  const idealista =
    text.match(/idealista\.com\/(?:pro\/[\w-]+\/)?inmueble\/(\d{6,12})/i) ??
    text.match(/idealista\.com\/[^\s\]"'<>]*\/inmueble\/(\d{6,12})/i) ??
    text.match(/\bCod\.\s*(\d{6,12})\b/i);
  if (idealista?.[1]) return { portal: "idealista", externalId: idealista[1] };

  const fotocasa = text.match(/fotocasa\.(?:es|pro)\/[^\s\]"'<>]*?\/(\d{6,12})(?:\/|\b)/i);
  if (fotocasa?.[1]) return { portal: "fotocasa", externalId: fotocasa[1] };

  // pisos.com/.../piso-zona-65866607613_104700/  o .../65866607613_104700/
  const pisos =
    text.match(/pisos\.com\/[^\s\]"'<>]*?-(\d{8,14}_\d{3,8})(?:\/|\?|#|$)/i) ??
    text.match(/pisos\.com\/[^\s\]"'<>]*?\/(\d{8,14}_\d{3,8})(?:\/|\?|#|$)/i) ??
    text.match(/pisos\.com\/[^\s\]"'<>]*?-(\d{8,14})(?:\/|\?|#|$)/i);
  if (pisos?.[1]) return { portal: "pisos", externalId: pisos[1] };

  const indomio = text.match(/indomio\.[a-z.]+\/[^\s\]"'<>]*?\/(\d{6,12})/i);
  if (indomio?.[1]) return { portal: "indomio", externalId: indomio[1] };

  const habitaclia = text.match(/habitaclia\.com\/[^\s\]"'<>]*?\/(\d{6,12})/i);
  if (habitaclia?.[1]) return { portal: "habitaclia", externalId: habitaclia[1] };

  const milanuncios = text.match(/milanuncios\.com\/[^\s\]"'<>]*?\/(\d{6,12})/i);
  if (milanuncios?.[1]) return { portal: "milanuncios", externalId: milanuncios[1] };

  return null;
}

/** @deprecated usar extractPortalAdRef */
export function extractIdealistaAdId(text: string): string | null {
  const hit = extractPortalAdRef(text);
  return hit?.portal === "idealista" ? hit.externalId : null;
}

function extractNearbyPropertyRef(text: string): string | null {
  return (
    sanitizePropertyRef(text.match(/con\s+referencia\s+(\d{3,4})\b/i)?.[1]) ??
    sanitizePropertyRef(text.match(/con\s+ref:\s*(\d{3,4})\b/i)?.[1]) ??
    sanitizePropertyRef(text.match(/\breferencia\s+(\d{3,4})\b/i)?.[1]) ??
    sanitizePropertyRef(text.match(/\bref\.?\s*:?\s*(\d{3,4})\b/i)?.[1]) ??
    null
  );
}

/**
 * Aprende mapeos portal→ref desde texto (emails Habitatsoft / portales).
 * Patrones: "Cod. …" + "Ref. …", o URL de portal junto a "referencia 1759".
 */
export function ingestPortalMappingsFromText(text: string): void {
  if (!text?.trim()) return;

  const codRef =
    text.match(/Cod\.\s*(\d{6,12})[\s\S]{0,200}?Ref\.\s*(\d{3,4})\b/i) ??
    text.match(/Ref\.\s*(\d{3,4})\b[\s\S]{0,200}?Cod\.\s*(\d{6,12})/i);
  if (codRef) {
    const a = codRef[1]!;
    const b = codRef[2]!;
    if (/^\d{6,12}$/.test(a) && /^\d{3,4}$/.test(b)) {
      rememberPortalListing("idealista", a, b);
    } else if (/^\d{3,4}$/.test(a) && /^\d{6,12}$/.test(b)) {
      rememberPortalListing("idealista", b, a);
    }
  }

  const ad = extractPortalAdRef(text);
  const refNearAd = extractNearbyPropertyRef(text);
  if (ad && refNearAd) {
    rememberPortalListing(ad.portal, ad.externalId, refNearAd);
  }
}

/** Resuelve ref Bazán desde cualquier enlace/texto de portal conocido. */
export function resolveRefFromPortalText(text: string): string | null {
  const ad = extractPortalAdRef(text);
  if (!ad) return null;
  return lookupPortalListing(ad.portal, ad.externalId);
}
