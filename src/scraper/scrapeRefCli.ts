import "dotenv/config";
import { scrapePropertyPage } from "./propertyPage.js";
import { config } from "../config.js";

const ref = process.argv[2]?.trim();
if (!ref || !/^\d{3,6}$/.test(ref)) {
  console.error("Uso: npm run scrape:ref:dev -- REF   (ej. 1726)");
  process.exit(1);
}

const base = config.scrapeTargetUrl.replace(/\/$/, "");
const row = await scrapePropertyPage(base, ref);
console.log(JSON.stringify(row, null, 2));
