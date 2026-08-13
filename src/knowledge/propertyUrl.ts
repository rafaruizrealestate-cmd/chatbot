import { config } from "../config.js";

/** Enlace público del anuncio (Idealista) para WhatsApp: fotos y ficha. */
export function publicPropertyUrl(p: { ref: string; url?: string | null }): string | null {
  const fromRow = p.url?.trim();
  if (fromRow && isAllowedCustomerListingUrl(fromRow)) return fromRow;
  const ref = p.ref?.trim();
  if (!ref) return null;
  if (/^\d{6,12}$/.test(ref)) {
    return `https://www.idealista.com/inmueble/${encodeURIComponent(ref)}/`;
  }
  if (fromRow) return fromRow;
  const base = config.scrapeTargetUrl.replace(/\/$/, "");
  if (/idealista\.com/i.test(base)) return null;
  return `${base}/propiedad?propiedad=${encodeURIComponent(ref)}`;
}

/** URLs que sí podemos mandar al cliente (nuestro anuncio, no un portal ajeno). */
export function isAllowedCustomerListingUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "mamboinmobiliaria.com" || host === "inmobiliariabazan.com") return true;
    if (host === "idealista.com") {
      return /\/(?:pro\/[\w-]+\/)?inmueble\/\d{6,12}\/?/i.test(u.pathname);
    }
    return false;
  } catch {
    return false;
  }
}
