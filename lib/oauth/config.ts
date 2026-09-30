import { getPublicOrigin } from "mcp-handler";

export const SCOPE = "solsol:read";

/** Lifetimes in seconds. */
export const TTL = {
  code: 60,
  authorizeTx: 10 * 60,
  accessToken: 60 * 60,
  refreshToken: 30 * 24 * 60 * 60,
  eshopSession: 30 * 24 * 60 * 60,
  client: 365 * 24 * 60 * 60,
  clientMetadataCache: 60 * 60,
  reuseMarker: 60 * 60,
} as const;

export function issuer(req: Request): string {
  const configured = process.env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return configured || getPublicOrigin(req);
}

export const resourceUrl = (req: Request) => `${issuer(req)}/mcp`;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

export const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) =>
  json({ error, error_description: description }, status, headers);

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** Reads an OAuth request body: form-encoded per spec, JSON tolerated for lenient clients. */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}
