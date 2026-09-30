import { clientIp, getRuntime } from "./runtime";
import { json, oauthError, TTL } from "./config";
import { randomToken, safeEqual, sha256 } from "./crypto";

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface Client {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  client_secret_hash?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only https callbacks, or http on a loopback host (native / CLI clients). No fragments, no credentials. */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Does a requested redirect_uri match one of the client's registered URIs?
 * Exact match, except that loopback http URIs ignore the port (RFC 8252 §7.3):
 * native / CLI clients pick a free port at runtime.
 */
export function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  if (!isAllowedRedirectUri(requested)) return false;
  const req = new URL(requested);
  if (req.protocol !== "http:" || !LOOPBACK_HOSTS.has(req.hostname)) return false;
  return registered.some((uri) => {
    if (!isAllowedRedirectUri(uri)) return false;
    const reg = new URL(uri);
    return reg.protocol === "http:" && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
  });
}

const isMetadataDocumentUrl = (clientId: string) => clientId.startsWith("https://");

const cleanName = (name: unknown) =>
  typeof name === "string" ? name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100) || undefined : undefined;

// ---------- Dynamic Client Registration (RFC 7591) ----------

export async function handleRegister(req: Request): Promise<Response> {
  const { kv, registerLimiter } = getRuntime();
  if (!(await registerLimiter.limit(`ip:${clientIp(req)}`)).success) {
    return oauthError("invalid_request", "Too many registrations, try again later", 429);
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Body must be a JSON object");

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    return oauthError("invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
    return oauthError("invalid_redirect_uri", "Only https:// or http://localhost redirect URIs are allowed");
  }
  const grantTypes = (body.grant_types as unknown[] | undefined) ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return oauthError("invalid_client_metadata", "Supported grant_types: authorization_code, refresh_token");
  }
  const responseTypes = (body.response_types as unknown[] | undefined) ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) {
    return oauthError("invalid_client_metadata", "Only response_type 'code' is supported");
  }
  const requested = (body.token_endpoint_auth_method as string | undefined) ?? "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(requested)) {
    return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
  }

  const client: Client = {
    client_id: randomToken(16),
    client_name: cleanName(body.client_name),
    redirect_uris: redirectUris as string[],
    token_endpoint_auth_method: requested as AuthMethod,
  };
  let clientSecret: string | undefined;
  if (client.token_endpoint_auth_method !== "none") {
    clientSecret = randomToken(32);
    client.client_secret_hash = sha256(clientSecret);
  }
  await kv.set(`client:${client.client_id}`, client, TTL.client);

  return json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    },
    201,
  );
}

// ---------- Client ID Metadata Documents ----------

async function fetchClientMetadataDocument(clientId: string): Promise<Client | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  // SSRF guard: public https hostnames on the default port only.
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.pathname === "/" ||
    url.hash ||
    url.username ||
    LOOPBACK_HOSTS.has(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.startsWith("[") ||
    !url.hostname.includes(".")
  ) {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 10_000) return null;
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc.client_id !== clientId) return null;
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) return null;
  const method = (doc.token_endpoint_auth_method as string | undefined) ?? "none";
  if (method !== "none") return null;
  return { client_id: clientId, client_name: cleanName(doc.client_name), redirect_uris: redirectUris, token_endpoint_auth_method: "none" };
}

export async function getClient(clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  const { kv } = getRuntime();
  if (!isMetadataDocumentUrl(clientId)) return kv.get<Client>(`client:${clientId}`);

  const cacheKey = `client-doc:${sha256(clientId)}`;
  const cached = await kv.get<Client>(cacheKey);
  if (cached) return cached;
  const client = await fetchClientMetadataDocument(clientId);
  if (client) await kv.set(cacheKey, client, TTL.clientMetadataCache);
  return client;
}

/** Authenticates the client at the token endpoint according to its registered method. */
export async function authenticateClient(req: Request, params: Record<string, string>): Promise<Client | null> {
  let clientId = params.client_id;
  let secret = params.client_secret;
  const basic = req.headers.get("authorization");
  if (basic?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      clientId = decodeURIComponent(decoded.slice(0, sep));
      secret = decodeURIComponent(decoded.slice(sep + 1));
    }
  }
  if (!clientId) return null;
  const client = await getClient(clientId);
  if (!client) return null;
  if (client.token_endpoint_auth_method === "none") return client;
  if (!secret || !client.client_secret_hash) return null;
  return safeEqual(sha256(secret), client.client_secret_hash) ? client : null;
}
