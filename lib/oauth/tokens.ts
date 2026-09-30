import type { AuthInfo } from "@modelcontextprotocol/server";
import { authenticateClient } from "./clients";
import { json, oauthError, readParams, TTL } from "./config";
import { PKCE_VERIFIER_RE, pkceS256, randomToken, safeEqual, sha256 } from "./crypto";
import { getRuntime } from "./runtime";
import { revokeSession, sessionExists } from "./session";

interface Grant {
  clientId: string;
  sessionId: string;
  scope: string;
  resource: string;
}

export interface CodeRecord extends Grant {
  redirectUri: string;
  codeChallenge: string;
}

interface AccessRecord extends Grant {
  expiresAt: number;
}

const k = {
  code: (code: string) => `code:${sha256(code)}`,
  codeUsed: (code: string) => `code-used:${sha256(code)}`,
  access: (token: string) => `at:${sha256(token)}`,
  refresh: (token: string) => `rt:${sha256(token)}`,
  refreshUsed: (token: string) => `rt-used:${sha256(token)}`,
};

export async function issueAuthorizationCode(record: CodeRecord): Promise<string> {
  const code = randomToken(32);
  await getRuntime().kv.set(k.code(code), record, TTL.code);
  return code;
}

async function issueTokenPair(grant: Grant) {
  const { kv } = getRuntime();
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + TTL.accessToken;
  await Promise.all([
    kv.set(k.access(accessToken), { ...grant, expiresAt } satisfies AccessRecord, TTL.accessToken),
    kv.set(k.refresh(refreshToken), grant, TTL.refreshToken),
  ]);
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TTL.accessToken,
    refresh_token: refreshToken,
    scope: grant.scope,
  });
}

async function exchangeCode(params: Record<string, string>, clientId: string) {
  const { kv } = getRuntime();
  const { code, redirect_uri: redirectUri, code_verifier: verifier } = params;
  if (!code || !redirectUri || !verifier) {
    return oauthError("invalid_request", "code, redirect_uri and code_verifier are required");
  }
  const record = await kv.getdel<CodeRecord>(k.code(code));
  if (!record) {
    // Replay of an already redeemed code: revoke everything that was issued from it (RFC 9700 §4.2.4).
    const sessionId = await kv.getdel<string>(k.codeUsed(code));
    if (sessionId) await revokeSession(sessionId);
    return oauthError("invalid_grant", "Authorization code is invalid, expired or already used");
  }
  await kv.set(k.codeUsed(code), record.sessionId, TTL.reuseMarker);

  const pkceOk = PKCE_VERIFIER_RE.test(verifier) && safeEqual(pkceS256(verifier), record.codeChallenge);
  if (record.clientId !== clientId || record.redirectUri !== redirectUri || !pkceOk) {
    await revokeSession(record.sessionId);
    const reason = !pkceOk ? "PKCE verification failed" : "client_id or redirect_uri does not match the authorization request";
    return oauthError("invalid_grant", reason);
  }
  return issueTokenPair(record);
}

async function exchangeRefreshToken(params: Record<string, string>, clientId: string) {
  const { kv } = getRuntime();
  const token = params.refresh_token;
  if (!token) return oauthError("invalid_request", "refresh_token is required");
  const grant = await kv.getdel<Grant>(k.refresh(token));
  if (!grant) {
    // A rotated-out refresh token was presented again: assume theft, kill the session.
    const sessionId = await kv.getdel<string>(k.refreshUsed(token));
    if (sessionId) await revokeSession(sessionId);
    return oauthError("invalid_grant", "Refresh token is invalid, expired or already used");
  }
  await kv.set(k.refreshUsed(token), grant.sessionId, TTL.refreshToken);
  if (grant.clientId !== clientId) return oauthError("invalid_grant", "Refresh token was issued to another client");
  if (!(await sessionExists(grant.sessionId))) {
    return oauthError("invalid_grant", "The SOLSOL session has ended, sign in again");
  }
  return issueTokenPair(grant);
}

export async function handleToken(req: Request): Promise<Response> {
  const params = await readParams(req);
  const client = await authenticateClient(req, params);
  if (!client) return oauthError("invalid_client", "Client authentication failed", 401);
  switch (params.grant_type) {
    case "authorization_code":
      return exchangeCode(params, client.client_id);
    case "refresh_token":
      return exchangeRefreshToken(params, client.client_id);
    default:
      return oauthError("unsupported_grant_type", "Supported: authorization_code, refresh_token");
  }
}

/** Token verifier for withMcpAuth. Throws on a presented-but-invalid token so the client gets a 401. */
export async function verifyAccessToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const record = await getRuntime().kv.get<AccessRecord>(k.access(bearerToken));
  if (!record || !(await sessionExists(record.sessionId))) throw new Error("invalid_token");
  return {
    token: bearerToken,
    clientId: record.clientId,
    scopes: record.scope.split(" "),
    expiresAt: record.expiresAt,
    resource: new URL(record.resource),
    extra: { sessionId: record.sessionId },
  };
}

/**
 * Logout / revocation (RFC 7009 shape). Accepts the access token as a Bearer header or an access or
 * refresh token as `token`. Revokes the MCP token and deletes the stored eshop tokens.
 */
export async function handleLogout(req: Request): Promise<Response> {
  const { kv } = getRuntime();
  const params = await readParams(req).catch(() => ({}) as Record<string, string>);
  const auth = req.headers.get("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : params.token;
  if (!token) return oauthError("invalid_request", "Provide the token to revoke");

  const [access, refresh] = await Promise.all([
    kv.getdel<AccessRecord>(k.access(token)),
    kv.getdel<Grant>(k.refresh(token)),
  ]);
  const sessionId = access?.sessionId ?? refresh?.sessionId;
  if (sessionId) await revokeSession(sessionId);
  return json({ revoked: true });
}
