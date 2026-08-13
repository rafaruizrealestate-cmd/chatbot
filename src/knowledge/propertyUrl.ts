import { config } from "../config.js";

export function publicPropertyUrl(p: { ref: string; url?: string | null }): string | null {
  const fromRow = p.url?.trim();
  if (fromRow) return fromRow;
  const ref = p.ref?.trim();
  if (!ref) return null;
  if (/^\d{6,12}$/.test(ref)) {
    return `https://www.idealista.com/inmueble/${encodeURIComponent(ref)}/`;
  }
  const base = config.scrapeTargetUrl.replace(/\/$/, "");
  if (/idealista\.com/i.test(base)) return null;
  return `${base}/propiedad?propiedad=${encodeURIComponent(ref)}`;
}
