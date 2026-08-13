import { getDb, getPropertiesDb } from "../db/database.js";
import {
  catalogPropertyRef,
  extractAllPropertyRefCandidates,
  extractPropertyRefFromText,
} from "../utils/propertyRef.js";
import { extractPortalAdRef, lookupPortalListing } from "./portalListings.js";

export type PropertyRow = {
  ref: string;
  title: string;
  property_type: string | null;
  transaction_type: string | null;
  price: number | null;
  area_m2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  location: string | null;
  features: string | null;
  description: string | null;
  url: string | null;
  agent_name?: string | null;
  agent_phone?: string | null;
  agent_user_id?: number | null;
};

const PROPERTY_SELECT = `ref, title, property_type, transaction_type, price, area_m2,
      bedrooms, bathrooms, location, features, description, url,
      agent_name, agent_phone, agent_user_id`;

export function replaceAllProperties(rows: PropertyRow[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM properties").run();
    const ins = db.prepare(`
      INSERT INTO properties (
        ref, title, property_type, transaction_type, price, area_m2,
        bedrooms, bathrooms, location, features, description, url,
        agent_name, agent_phone, agent_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      ins.run(
        r.ref,
        r.title,
        r.property_type,
        r.transaction_type,
        r.price,
        r.area_m2,
        r.bedrooms,
        r.bathrooms,
        r.location,
        r.features,
        r.description,
        r.url,
        r.agent_name ?? null,
        r.agent_phone ?? null,
        r.agent_user_id ?? null
      );
    }
  });
  tx();
}

export type SearchFilters = {
  transaction_type?: string;
  property_type?: string;
  max_price?: number;
  min_price?: number;
  min_bedrooms?: number;
  location_contains?: string;
  features_any?: string[];
  ref?: string;
  limit?: number;
  /** Excluye Oficina, Local, Garaje, Nave, Terreno, Parcela. */
  residential_only?: boolean;
  /** Excluye habitaciones en piso compartido (título HABITACION…). */
  exclude_shared_rooms?: boolean;
};

const NON_RESIDENTIAL_PROPERTY_TYPES = [
  "oficina",
  "local",
  "garaje",
  "nave",
  "terreno",
  "parcela",
];

export function searchProperties(filters: SearchFilters): PropertyRow[] {
  const db = getPropertiesDb();
  const limit = Math.min(Math.max(filters.limit ?? 15, 1), 50);
  const conditions: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filters.ref) {
    conditions.push("ref = ?");
    params.push(filters.ref.trim());
    const sql = `SELECT ${PROPERTY_SELECT}
      FROM properties WHERE ${conditions.join(" AND ")}
      LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as PropertyRow[];
  }

  if (filters.transaction_type) {
    conditions.push("LOWER(transaction_type) = LOWER(?)");
    params.push(filters.transaction_type.trim());
  }
  if (filters.property_type) {
    conditions.push("LOWER(property_type) LIKE LOWER(?)");
    params.push(`%${filters.property_type.trim()}%`);
  }
  if (filters.max_price != null) {
    conditions.push("(price IS NOT NULL AND price <= ?)");
    params.push(filters.max_price);
  }
  if (filters.min_price != null) {
    conditions.push("(price IS NOT NULL AND price >= ?)");
    params.push(filters.min_price);
  }
  if (filters.min_bedrooms != null) {
    conditions.push("(bedrooms IS NOT NULL AND bedrooms >= ?)");
    params.push(filters.min_bedrooms);
  }
  if (filters.location_contains) {
    // Zona puede venir en location, title o description (p. ej. "Carlos Haya").
    conditions.push(`(
      LOWER(COALESCE(location, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(title, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(description, '')) LIKE LOWER(?)
    )`);
    const like = `%${filters.location_contains.trim()}%`;
    params.push(like, like, like);
  }

  if (filters.features_any && filters.features_any.length > 0) {
    const orParts = filters.features_any.map((feat) => {
      params.push(`%${feat.toLowerCase().trim()}%`);
      return "LOWER(COALESCE(features, '')) LIKE ?";
    });
    conditions.push(`(${orParts.join(" OR ")})`);
  }

  if (filters.residential_only) {
    const placeholders = NON_RESIDENTIAL_PROPERTY_TYPES.map(() => "?").join(", ");
    conditions.push(`LOWER(COALESCE(property_type, '')) NOT IN (${placeholders})`);
    params.push(...NON_RESIDENTIAL_PROPERTY_TYPES);
  }
  if (filters.exclude_shared_rooms) {
    conditions.push(`UPPER(COALESCE(title, '')) NOT LIKE 'HABITACION%'`);
    conditions.push(`LOWER(COALESCE(property_type, '')) NOT IN ('habitación', 'habitacion')`);
  }

  const sql = `SELECT ${PROPERTY_SELECT}
    FROM properties WHERE ${conditions.join(" AND ")}
    ORDER BY price IS NULL, price ASC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as PropertyRow[];
}

export function countProperties(): number {
  const db = getPropertiesDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM properties").get() as { c: number };
  return row.c;
}

export type ScrapedAgentContact = { name: string; phone: string };

export function listDistinctAgentContacts(): ScrapedAgentContact[] {
  const db = getPropertiesDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT agent_name AS name, agent_phone AS phone
       FROM properties
       WHERE agent_name IS NOT NULL AND trim(agent_name) != ''
         AND agent_phone IS NOT NULL AND trim(agent_phone) != ''
       ORDER BY agent_name`
    )
    .all() as ScrapedAgentContact[];
  return rows.map((r) => ({
    name: r.name.trim(),
    phone: r.phone.replace(/\D+/g, ""),
  }));
}

export function listDistinctAgentPhones(): string[] {
  return listDistinctAgentContacts().map((a) => a.phone);
}

/** True si la ref existe en el catálogo scrapeado (BD de propiedades). */
export function propertyExistsByRef(ref: string): boolean {
  const r = catalogPropertyRef(ref);
  if (!r) return false;
  return searchProperties({ ref: r, limit: 1 }).length > 0;
}

/**
 * Resuelve la ref del mensaje priorizando fichas que existen en el scrape.
 * Sin comerciales estáticos: el agente sale luego de agent_name/phone de esa ficha.
 */
export function resolvePropertyRefFromCatalog(text: string): string | null {
  const portal = extractPortalAdRef(text);
  if (portal) {
    const mapped = lookupPortalListing(portal.portal, portal.externalId);
    if (mapped && propertyExistsByRef(mapped)) return mapped;
    if (propertyExistsByRef(portal.externalId)) return portal.externalId;
  }

  const explicit = extractPropertyRefFromText(text);
  if (explicit && propertyExistsByRef(explicit)) return explicit;

  for (const c of extractAllPropertyRefCandidates(text)) {
    if (propertyExistsByRef(c)) return c;
  }

  // "ref. 9999" explícita aunque aún no esté en BD (scrape retrasado).
  return explicit;
}

export function updatePropertyAgentMeta(
  ref: string,
  agent_name: string,
  agent_phone: string,
  agent_user_id?: number | null
): void {
  const db = getDb();
  db.prepare(
    `UPDATE properties SET agent_name = ?, agent_phone = ?, agent_user_id = ? WHERE ref = ?`
  ).run(agent_name, agent_phone, agent_user_id ?? null, ref);
}
