import "dotenv/config";
import { runFullScrape } from "./index.js";

async function main(): Promise<void> {
  console.log("Iniciando scraping...");
  const r = await runFullScrape();
  console.log("Listo:", r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
