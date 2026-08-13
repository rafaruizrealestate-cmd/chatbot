import type { ParsedMail } from "mailparser";

function stripAngleBrackets(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

/** Normaliza a forma `<id@host>` para cabeceras RFC. */
export function normalizeMessageId(id: string): string {
  const inner = stripAngleBrackets(id);
  if (!inner) return "";
  return `<${inner}>`;
}

function referencesToNormalizedArray(refs: string[] | string | undefined): string[] {
  if (!refs) return [];
  const parts = Array.isArray(refs) ? refs : refs.trim().split(/\s+/);
  return parts.map((r) => normalizeMessageId(r)).filter((r) => r.length > 2);
}

/**
 * Cabeceras para que la respuesta quede en el mismo hilo que el mensaje entrante
 * (Mail, Gmail, etc. usan In-Reply-To + References).
 */
export function buildReplyThreadingHeaders(
  parsed: ParsedMail,
): { inReplyTo: string; references: string } | null {
  const parentRaw = parsed.messageId;
  if (!parentRaw?.trim()) return null;

  const inReplyTo = normalizeMessageId(parentRaw);
  if (!inReplyTo || inReplyTo === "<>") return null;

  const fromIncoming = referencesToNormalizedArray(parsed.references);
  const chain: string[] = [];
  const seen = new Set<string>();

  for (const id of fromIncoming) {
    const key = stripAngleBrackets(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    chain.push(id);
  }

  const parentKey = stripAngleBrackets(inReplyTo);
  if (!seen.has(parentKey)) {
    chain.push(inReplyTo);
  }

  return {
    inReplyTo,
    references: chain.join(" "),
  };
}
