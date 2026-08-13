import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica X-Hub-Signature-256 (Meta).
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!appSecret.trim()) return true;
  if (!rawBody || rawBody.length === 0) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const receivedHex = signatureHeader.slice("sha256=".length).trim();
  if (!/^[0-9a-f]+$/i.test(receivedHex) || receivedHex.length !== expectedHex.length) {
    return false;
  }
  try {
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(receivedHex, "hex");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
