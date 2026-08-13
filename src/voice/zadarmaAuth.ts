import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { config } from "../config.js";

function formBodyParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Firma HMAC-SHA1 base64 según documentación Zadarma PBX webhooks. */
export function buildZadarmaSignature(parts: string[], secretOverride?: string): string | null {
  const secret = (secretOverride ?? config.zadarmaApiSecret).trim();
  if (!secret) return null;
  return createHmac("sha1", secret).update(parts.join("")).digest("base64");
}

export function verifyZadarmaNotifyStart(params: Record<string, string>, signature: string | undefined): boolean {
  const expected = buildZadarmaSignature([
    params.caller_id ?? "",
    params.called_did ?? "",
    params.call_start ?? "",
  ]);
  if (!expected) return config.zadarmaSkipSignatureVerify;
  if (!signature?.trim()) return false;
  return safeEqual(expected, signature.trim());
}

export function verifyZadarmaNotifyAnswer(params: Record<string, string>, signature: string | undefined): boolean {
  const expected = buildZadarmaSignature([
    params.caller_id ?? "",
    params.destination ?? "",
    params.call_start ?? "",
  ]);
  if (!expected) return config.zadarmaSkipSignatureVerify;
  if (!signature?.trim()) return false;
  return safeEqual(expected, signature.trim());
}

export function zadarmaParams(req: Request): Record<string, string> {
  return formBodyParams(req.body);
}

export function zadarmaSignatureFromReq(req: Request): string | undefined {
  const header =
    req.get("x-zadarma-signature") ??
    req.get("authorization") ??
    (typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>).signature
      : undefined);
  return typeof header === "string" ? header : undefined;
}

export function assertZadarmaRequest(req: Request, event: string): boolean {
  if (config.zadarmaSkipSignatureVerify) {
    console.warn("[voice/zadarma] ZADARMA_SKIP_SIGNATURE_VERIFY=1");
    return true;
  }
  const params = zadarmaParams(req);
  const sig = zadarmaSignatureFromReq(req);
  if (event === "NOTIFY_ANSWER") return verifyZadarmaNotifyAnswer(params, sig);
  if (event === "NOTIFY_START" || event === "NOTIFY_END") {
    return verifyZadarmaNotifyStart(params, sig);
  }
  return Boolean(config.zadarmaApiSecret.trim());
}
