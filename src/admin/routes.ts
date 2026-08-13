import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { config, assertAdminConfigured } from "../config.js";
import { runFullScrape } from "../scraper/index.js";
import { listChunksSummary, deleteChunkById, countChunks } from "../knowledge/vectorStore.js";
import { countProperties } from "../knowledge/properties.js";
import { ingestPlainText, ingestPdfBuffer, ingestDocxBuffer } from "../knowledge/ingest.js";
import { runOperationalAudit } from "./audit.js";
import { getVoiceCall, getVoiceCallTurns, listVoiceCalls } from "../voice/voiceCallStore.js";

const uploadDir = path.join(process.cwd(), "uploads");
try {
  mkdirSync(uploadDir, { recursive: true });
} catch {
  // ignore
}

const upload = multer({ dest: uploadDir, limits: { fileSize: 15 * 1024 * 1024 } });

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    assertAdminConfigured();
  } catch {
    res.status(500).json({ error: "ADMIN_API_KEY no configurada" });
    return;
  }
  const key = req.header("x-admin-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== config.adminApiKey) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  next();
}

export function registerAdminRoutes(app: Express): void {
  app.get("/admin/health", (_req, res) => {
    res.json({ ok: true, properties: countProperties(), knowledgeChunks: countChunks() });
  });

  app.get("/admin/audit", adminAuth, (req, res) => {
    const raw = req.query.hours;
    const hours = Number.parseInt(Array.isArray(raw) ? String(raw[0]) : String(raw ?? "72"), 10);
    try {
      res.json({ ok: true, audit: runOperationalAudit(Number.isFinite(hours) ? hours : 72) });
    } catch (e) {
      console.error("[admin] audit failed", e);
      res.status(500).json({ error: "audit_failed", detail: String(e) });
    }
  });

  app.post("/admin/scrape", adminAuth, async (_req, res) => {
    try {
      const r = await runFullScrape();
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "scrape_failed", detail: String(e) });
    }
  });

  app.get("/admin/knowledge", adminAuth, (_req, res) => {
    res.json({ chunks: listChunksSummary() });
  });

  app.get("/admin/voice/calls", adminAuth, (req, res) => {
    const parseInt10 = (raw: unknown, fallback: number) => {
      const n = Number.parseInt(Array.isArray(raw) ? String(raw[0]) : String(raw ?? ""), 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const limit = parseInt10(req.query.limit, 50);
    const offset = parseInt10(req.query.offset, 0);
    res.json({ ok: true, calls: listVoiceCalls(limit, offset) });
  });

  app.get("/admin/voice/calls/:id", adminAuth, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const call = getVoiceCall(String(id));
    if (!call) {
      res.status(404).json({ error: "call_not_found" });
      return;
    }
    res.json({ ok: true, call, turns: getVoiceCallTurns(String(id)) });
  });

  app.delete("/admin/knowledge/:id", adminAuth, (req, res) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    deleteChunkById(id);
    res.json({ ok: true });
  });

  app.post("/admin/knowledge/text", adminAuth, async (req, res) => {
    const title = String(req.body?.title ?? "manual");
    const text = String(req.body?.text ?? "");
    if (!text.trim()) {
      res.status(400).json({ error: "text_required" });
      return;
    }
    try {
      const n = await ingestPlainText(`manual:${title}`, text);
      res.json({ ok: true, chunksAdded: n });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post(
    "/admin/knowledge/upload",
    adminAuth,
    upload.single("file"),
    async (req, res) => {
      const f = req.file;
      if (!f?.path || !f.originalname) {
        res.status(400).json({ error: "file_required" });
        return;
      }
      const buf = await import("node:fs/promises").then((fs) => fs.readFile(f.path));
      const ext = path.extname(f.originalname).toLowerCase();
      try {
        let n = 0;
        if (ext === ".pdf") n = await ingestPdfBuffer(f.originalname, buf);
        else if (ext === ".docx") n = await ingestDocxBuffer(f.originalname, buf);
        else if (ext === ".txt" || ext === ".md") n = await ingestPlainText(`file:${f.originalname}`, buf.toString("utf8"));
        else {
          res.status(400).json({ error: "unsupported_type", ext });
          return;
        }
        res.json({ ok: true, chunksAdded: n });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      } finally {
        void import("node:fs/promises").then((fs) => fs.unlink(f.path).catch(() => undefined));
      }
    }
  );
}
