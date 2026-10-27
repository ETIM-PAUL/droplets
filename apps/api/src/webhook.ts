import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("hex");

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Mavapay signs with HMAC-SHA256 (hex) in X-Mavapay-Signature. Their docs compute it over
 * JSON.stringify(parsedBody), so accept that as well as the raw body.
 */
export function verifyMavapaySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const sig = signature.trim().toLowerCase();
  if (same(sig, sign(rawBody, secret))) return true;
  try {
    return same(sig, sign(JSON.stringify(JSON.parse(rawBody)), secret));
  } catch {
    return false;
  }
}
