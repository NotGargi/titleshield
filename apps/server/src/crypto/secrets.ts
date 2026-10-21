import crypto from "node:crypto";
import { config } from "../config.ts";

/** scrypt password hashing: "scrypt$salt$hash" */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("hex")}$${h.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, "hex"));
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

/** Field-level AES-256-GCM for PII such as bank account numbers (PDF §12). */
function fieldKey(): Buffer {
  const k = config.FIELD_ENCRYPTION_KEY;
  if (k) {
    const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "base64");
    if (buf.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
    return buf;
  }
  if (config.NODE_ENV === "production") throw new Error("FIELD_ENCRYPTION_KEY is required in production");
  return crypto.createHash("sha256").update(`dev-field-key:${config.JWT_SECRET}`).digest();
}

export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", fieldKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `gcm1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptField(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "gcm1") throw new Error("Unknown field encryption version");
  const d = crypto.createDecipheriv("aes-256-gcm", fieldKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export const maskAccount = (acc: string) => `XXXX${acc.replace(/\s/g, "").slice(-4)}`;

export function hmacSha256(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

export const randomId = (prefix: string, bytes = 6) => `${prefix}${crypto.randomBytes(bytes).toString("hex").toUpperCase()}`;
