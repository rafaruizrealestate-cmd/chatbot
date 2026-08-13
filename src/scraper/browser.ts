import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);

const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveScrapeBrowserBin(): string {
  const fromEnv = (process.env.SCRAPE_BROWSER_BIN || "").trim();
  if (fromEnv) {
    if (!isExecutable(fromEnv)) {
      throw new Error(`[scrape] SCRAPE_BROWSER_BIN no es ejecutable: ${fromEnv}`);
    }
    return fromEnv;
  }
  for (const p of BROWSER_CANDIDATES) {
    if (isExecutable(p)) return p;
  }
  throw new Error(
    "[scrape] No hay Chrome/Chromium. Instala chromium en el VPS o define SCRAPE_BROWSER_BIN."
  );
}

function looksBlocked(html: string): boolean {
  const t = html.slice(0, 4000).toLowerCase();
  return (
    html.length < 8000 ||
    t.includes("please enable js and disable any ad blocker") ||
    (t.includes("captcha") && t.includes("datadome"))
  );
}

/** Renderiza la URL con Chrome headless (Idealista bloquea axios/curl). */
export async function fetchRenderedHtml(url: string): Promise<string> {
  const bin = resolveScrapeBrowserBin();
  const { stdout } = await execFileAsync(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--virtual-time-budget=12000",
      "--timeout=25000",
      `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`,
      "--dump-dom",
      url,
    ],
    {
      timeout: 45000,
      maxBuffer: 12 * 1024 * 1024,
      encoding: "utf8",
    }
  );
  const html = String(stdout ?? "");
  if (looksBlocked(html)) {
    throw new Error(`[scrape] Idealista bloqueó o devolvió HTML vacío: ${url} (${html.length} bytes)`);
  }
  return html;
}
