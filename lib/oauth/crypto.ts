import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class ConfigError extends Error {}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export const pkceS256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function encryptionKey(): Buffer {
  const raw = process.env.MCP_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new ConfigError("MCP_TOKEN_ENCRYPTION_KEY is not set");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new ConfigError("MCP_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex chars)");
  return key;
}

/** AES-256-GCM. `aad` binds the ciphertext to its storage key so records cannot be swapped. */
export function encrypt(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

export function decrypt(payload: string, aad: string): string {
  if (!payload.startsWith("v1.")) throw new Error("Unsupported ciphertext version");
  const buf = Buffer.from(payload.slice(3), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
