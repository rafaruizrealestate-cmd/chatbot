import Database from "better-sqlite3";
import { config } from "../config.js";
import path from "node:path";
import { mkdirSync } from "node:fs";

let db: Database.Database | null = null;
let propertiesDb: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(config.databasePath);
  mkdirSync(dir, { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

/** BD de inmuebles (scrape). Si PROPERTIES_DATABASE_PATH apunta a Leo, solo lectura. */
export function getPropertiesDb(): Database.Database {
  if (config.propertiesDatabasePath === config.databasePath) {
    return getDb();
  }
  if (propertiesDb) return propertiesDb;
  propertiesDb = new Database(config.propertiesDatabasePath, { readonly: true });
  return propertiesDb;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_conv_phone_time ON conversations(phone_number, timestamp);

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      property_type TEXT,
      transaction_type TEXT,
      price REAL,
      area_m2 REAL,
      bedrooms INTEGER,
      bathrooms INTEGER,
      location TEXT,
      features TEXT,
      description TEXT,
      url TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_props_tx_type ON properties(transaction_type, property_type);
    CREATE INDEX IF NOT EXISTS idx_props_price ON properties(price);

    CREATE TABLE IF NOT EXISTS lead_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL,
      agent_phone TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      ref TEXT,
      intent TEXT,
      origin TEXT,
      summary TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_leads_customer_time
      ON lead_notifications(customer_phone, created_at);

    CREATE TABLE IF NOT EXISTS lead_profiles (
      customer_phone TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      intent_type TEXT,
      ref TEXT,
      budget REAL,
      monthly_income REAL,
      has_guarantor INTEGER,
      wants_visit INTEGER,
      extra_notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_state (
      uid INTEGER PRIMARY KEY,
      message_id TEXT,
      portal TEXT,
      from_address TEXT,
      subject_snippet TEXT,
      body_snippet TEXT,
      suppress_reason TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      handled INTEGER DEFAULT 0,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_email_portal ON email_state(portal, processed_at);
    CREATE INDEX IF NOT EXISTS idx_email_customer ON email_state(customer_email, processed_at);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(source);

    CREATE TABLE IF NOT EXISTS meta_webhook_dedup (
      dedup_key TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance TEXT,
      text TEXT NOT NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      attempts INTEGER DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_unprocessed
      ON whatsapp_pending(processed_at, received_at);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_conv
      ON whatsapp_pending(conversation_key, received_at);

    CREATE TABLE IF NOT EXISTS email_outbound_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_address TEXT NOT NULL,
      subject_snippet TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_email_outbound_to_time
      ON email_outbound_log(to_address, sent_at);
    CREATE INDEX IF NOT EXISTS idx_email_outbound_sent_at
      ON email_outbound_log(sent_at);

    CREATE TABLE IF NOT EXISTS ops_alerts_sent (
      alert_key TEXT PRIMARY KEY,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS muted_contacts (
      phone_number TEXT PRIMARY KEY,
      reason TEXT,
      muted_until DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voice_calls (
      id TEXT PRIMARY KEY,
      pbx_call_id TEXT,
      caller TEXT NOT NULL,
      called_did TEXT,
      language TEXT,
      intent TEXT,
      summary TEXT,
      disposition TEXT,
      audio_path TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_voice_calls_caller ON voice_calls(caller, started_at);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_pbx ON voice_calls(pbx_call_id);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_started ON voice_calls(started_at);

    CREATE TABLE IF NOT EXISTS voice_call_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turns_call ON voice_call_turns(call_id, ts);

    CREATE TABLE IF NOT EXISTS panel_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'viewer')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS panel_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_panel_sessions_expires ON panel_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS ai_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      channel_id TEXT,
      phone TEXT,
      tool TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_actions_time ON ai_actions(created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_actions_channel ON ai_actions(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_actions_tool ON ai_actions(tool, created_at);

    CREATE TABLE IF NOT EXISTS phone_lid (
      phone TEXT PRIMARY KEY,
      lid TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Backfill/migración suave: columnas de lead_notifications.
  const alterLeads = (sql: string) => {
    try {
      database.exec(sql);
    } catch {
      // ignore (columna ya existe)
    }
  };
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN origin TEXT;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN call_id TEXT;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN customer_name TEXT;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN customer_email TEXT;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN agent_wa INTEGER;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN agent_email INTEGER;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN client_wa INTEGER;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN client_email INTEGER;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN client_channel TEXT;`);
  alterLeads(`ALTER TABLE lead_notifications ADD COLUMN notes TEXT;`);
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_leads_call_id ON lead_notifications(call_id)`,
    );
  } catch {
    // ignore
  }

  // Migración suave: columnas de auditoría para emails.
  const alterEmail = (sql: string) => {
    try {
      database.exec(sql);
    } catch {
      // ignore
    }
  };
  alterEmail(`ALTER TABLE email_state ADD COLUMN subject_snippet TEXT;`);
  alterEmail(`ALTER TABLE email_state ADD COLUMN body_snippet TEXT;`);
  alterEmail(`ALTER TABLE email_state ADD COLUMN suppress_reason TEXT;`);

  const alterProps = (sql: string) => {
    try {
      database.exec(sql);
    } catch {
      // ignore
    }
  };
  alterProps(`ALTER TABLE properties ADD COLUMN agent_name TEXT;`);
  alterProps(`ALTER TABLE properties ADD COLUMN agent_phone TEXT;`);
  alterProps(`ALTER TABLE properties ADD COLUMN agent_user_id INTEGER;`);
}
