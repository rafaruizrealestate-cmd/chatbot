export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseSpanishMoney(raw: string): number | null {
  const t = raw.replace(/\s/g, "").replace(/€/g, "").replace(/\u00a0/g, "");
  const digits = t.replace(/[^\d.,]/g, "");
  if (!digits) return null;
  if (digits.includes(",") && digits.includes(".")) {
    const lastComma = digits.lastIndexOf(",");
    const lastDot = digits.lastIndexOf(".");
    const decSep = lastComma > lastDot ? "," : ".";
    const thouSep = decSep === "," ? "." : ",";
    const normalized = digits.replace(new RegExp(`\\${thouSep}`, "g"), "").replace(decSep, ".");
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
  }
  if (digits.includes(".")) {
    const parts = digits.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      const n = Number.parseFloat(digits.replace(/\./g, "").replace(/,/g, "."));
      return Number.isFinite(n) ? n : null;
    }
    const n = Number.parseFloat(digits.replace(/\./g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (digits.includes(",")) {
    const n = Number.parseFloat(digits.replace(/,/g, "."));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

export function parseAreaM2(raw: string): number | null {
  const m = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
