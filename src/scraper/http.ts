import axios from "axios";

const client = axios.create({
  timeout: 60000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; InmobiliariaBazanBot/1.0; +https://www.inmobiliariabazan.com)",
 Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "es-ES,es;q=0.9",
  },
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400,
});

export async function fetchHtml(url: string): Promise<string> {
  const res = await client.get<string>(url, { responseType: "text" });
  if (res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.data;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
