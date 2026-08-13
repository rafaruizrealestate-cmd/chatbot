/** Graph API version (alineado con WhatsApp sender). */
export const META_GRAPH_API_VERSION = "v25.0";

export function graphUrl(path: string): string {
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${p}`;
}
