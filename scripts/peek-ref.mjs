import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const ref = process.argv[2] ?? "1616";
const p = process.env.DATABASE_PATH || "./data/chatbot.db";
if (!existsSync(p)) {
  console.error("No existe:", p);
  process.exit(1);
}
const db = new Database(p, { readonly: true });
const row = db
  .prepare(
    "SELECT ref, title, price, transaction_type, property_type, location, url FROM properties WHERE ref = ?"
  )
  .get(ref);
console.log(row ? JSON.stringify(row, null, 2) : `No hay fila con ref ${ref}`);
db.close();
