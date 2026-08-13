const APPROX_CHARS_PER_TOKEN = 4;

export function chunkText(text: string, maxTokens = 500, overlapTokens = 50): string[] {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + maxChars, cleaned.length);
    let slice = cleaned.slice(start, end);
    if (end < cleaned.length) {
      const lastPeriod = slice.lastIndexOf(". ");
      const lastSpace = slice.lastIndexOf(" ");
      const cut = lastPeriod > slice.length * 0.5 ? lastPeriod + 1 : lastSpace;
      if (cut > 0) slice = slice.slice(0, cut);
    }
    const t = slice.trim();
    if (t) chunks.push(t);
    const step = Math.max(1, slice.length - overlapChars);
    start += step;
  }
  return chunks;
}
