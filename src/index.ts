import "dotenv/config";
import { execSync } from "node:child_process";
import express from "express";
import { config } from "./config.js";
import { getDb } from "./db/database.js";
import { handleWebhookVerify, handleWebhookPost } from "./whatsapp/webhook.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerPanelRoutes } from "./panel/routes.js";
import { handleEvolutionWebhookPost } from "./whatsapp/evolutionWebhook.js";
import { handleZadarmaWebhookGet, handleZadarmaWebhookPost } from "./voice/zadarmaWebhook.js";
import { handleVoiceManuelReply } from "./voice/voiceManuelApi.js";
import { registerVoiceRoutes } from "./voice/voiceRoutes.js";
import { handleRetellWebhook } from "./voice/retellWebhook.js";

getDb();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf: Buffer) => {
      (req as express.Request).rawBody = buf;
    },
  })
);

function readGitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return null;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, commit: readGitCommit() });
});

// Webhooks
// - Meta Cloud API:   GET /webhook (verify) + POST /webhook
// - Evolution API v2: POST /webhook (o /webhook/evolution si prefieres separar)
app.get("/webhook", (req, res) => {
  if (config.whatsappProvider === "meta") return handleWebhookVerify(req, res);
  res.sendStatus(200);
});

app.post("/webhook", (req, res) => {
  if (config.whatsappProvider === "evolution") {
    void handleEvolutionWebhookPost(req, res);
    return;
  }
  void handleWebhookPost(req, res);
});

// Rutas explícitas (útiles si quieres soportar ambos a la vez)
app.post("/webhook/evolution", (req, res) => {
  void handleEvolutionWebhookPost(req, res);
});
// Si en Evolution tienes "Webhook por eventos" activado, enviará a /webhook/<evento>
app.post("/webhook/messages-upsert", (req, res) => {
  void handleEvolutionWebhookPost(req, res);
});
app.post("/webhook/MESSAGES_UPSERT", (req, res) => {
  void handleEvolutionWebhookPost(req, res);
});
app.post("/webhook/meta", (req, res) => {
  void handleWebhookPost(req, res);
});
// Fallback para variantes de ruta por evento en Evolution
// (p.ej. /webhook/messages.upsert, /webhook/messages-upsert, etc.)
app.post("/webhook/:event", (req, res) => {
  void handleEvolutionWebhookPost(req, res);
});

registerAdminRoutes(app);

if (config.panelEnabled) {
  registerPanelRoutes(app);
  console.log(`[panel] Panel web en /panel (sesiones de ${config.panelSessionHours} h)`);
}

if (config.zadarmaEnabled) {
  app.get("/webhook/zadarma", handleZadarmaWebhookGet);
  app.post("/webhook/zadarma", (req, res) => {
    handleZadarmaWebhookPost(req, res);
  });
  console.log(
    `[voice] Zadarma webhook activo (DIDs=${config.zadarmaTrackedNumbers.join(",") || "todos"})`
  );
}

if (config.voiceApiKey.trim()) {
  console.log(`[voice] API Lara /voice/lara/reply activa (${config.botName})`);
  app.post("/voice/lara/reply", (req, res) => {
    void handleVoiceManuelReply(req, res).catch((err) => {
      console.error("[voice/lara/reply]", err);
      res.status(500).json({ error: "internal" });
    });
  });
  app.post("/voice/manuel/reply", (req, res) => {
    void handleVoiceManuelReply(req, res).catch((err) => {
      console.error("[voice/lara/reply]", err);
      res.status(500).json({ error: "internal" });
    });
  });
}

if (config.voiceManuelEnabled) {
  registerVoiceRoutes(app);
  console.log(
    `[voice] Agente ${config.botName} activo (always_on=${config.voiceManuelAlwaysOn ? "sí" : "no"})`
  );
}

if (config.retellEnabled) {
  app.post("/webhook/retell", (req, res) => {
    handleRetellWebhook(req, res);
  });
  console.log("[voice] Retell webhook activo en /webhook/retell");
}

app.listen(config.port, () => {
  console.log(`Servidor en http://0.0.0.0:${config.port}`);
  const wv = config.webhookVerifyToken;
  console.log(
    wv.length > 0
      ? `Webhook: verify token cargado (${wv.length} caracteres).`
      : "Webhook: AVISO — WEBHOOK_VERIFY_TOKEN vacío. Meta no podrá verificar; revisa .env y reinicia."
  );
});
