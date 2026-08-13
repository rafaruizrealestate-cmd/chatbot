#!/usr/bin/env -S node --import tsx
/** Auditoría local o en VPS: HOURS=72 npx tsx scripts/audit-cli.ts */
import "dotenv/config";
import { getDb } from "../src/db/database.js";
import { runOperationalAudit } from "../src/admin/audit.js";

const hours = Number.parseInt(process.env.HOURS ?? "72", 10);
getDb();
const audit = runOperationalAudit(Number.isFinite(hours) ? hours : 72);
console.log(JSON.stringify(audit, null, 2));
