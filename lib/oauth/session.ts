import type { AuthInfo } from "@modelcontextprotocol/server";
import { SessionExpiredError, type EshopTokens, type EshopTokenStore } from "../eshop";
import { TTL } from "./config";
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import { getRuntime } from "./runtime";

/**
 * One eshop login = one session. MCP access/refresh token records (keyed by the SHA-256 of the
 * opaque token) point at the session id; the eshop tokens themselves are stored only encrypted
 * under the SHA-256 of that id. Passwords are never stored anywhere.
 */
const vaultKey = (sessionId: string) => `eshop:${sha256(sessionId)}`;

export async function createEshopSession(tokens: EshopTokens): Promise<string> {
  const sessionId = randomToken(32);
  await saveEshopTokens(sessionId, tokens);
  return sessionId;
}

export async function saveEshopTokens(sessionId: string, tokens: EshopTokens) {
  const key = vaultKey(sessionId);
  await getRuntime().kv.set(key, encrypt(JSON.stringify(tokens), key), TTL.eshopSession);
}

export async function loadEshopTokens(sessionId: string): Promise<EshopTokens | null> {
  const key = vaultKey(sessionId);
  const payload = await getRuntime().kv.get<string>(key);
  if (!payload) return null;
  try {
    return JSON.parse(decrypt(payload, key)) as EshopTokens;
  } catch {
    return null;
  }
}

export async function sessionExists(sessionId: string) {
  return (await getRuntime().kv.get(vaultKey(sessionId))) !== null;
}

/** Deleting the vault entry invalidates every MCP token that points at this session. */
export async function revokeSession(sessionId: string) {
  await getRuntime().kv.del(vaultKey(sessionId));
}

export const eshopStoreFor = (sessionId: string): EshopTokenStore => ({
  load: () => loadEshopTokens(sessionId),
  save: (tokens) => saveEshopTokens(sessionId, tokens),
});

// Sessions whose eshop login died during the current request; the /mcp route turns these into HTTP 401.
const expiredSessions = new Set<string>();

export const consumeExpiredSession = (sessionId: string) => expiredSessions.delete(sessionId);

export function sessionIdOf(authInfo: AuthInfo | undefined): string | null {
  const id = authInfo?.extra?.sessionId;
  return typeof id === "string" ? id : null;
}

/** Runs an authenticated eshop operation for the caller of an MCP tool. */
export async function withPartnerSession<T>(
  authInfo: AuthInfo | undefined,
  fn: (store: EshopTokenStore) => Promise<T>,
): Promise<T> {
  const sessionId = sessionIdOf(authInfo);
  if (!sessionId) throw new SessionExpiredError("Sign in with your SOLSOL partner account to use this tool.");
  try {
    return await fn(eshopStoreFor(sessionId));
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      expiredSessions.add(sessionId);
      await revokeSession(sessionId);
    }
    throw e;
  }
}
