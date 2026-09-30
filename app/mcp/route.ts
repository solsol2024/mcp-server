import { createMcpHandler, getPublicOrigin, withMcpAuth } from "mcp-handler";
import { consumeExpiredSession, sessionIdOf } from "@/lib/oauth/session";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { registerPartnerTools } from "@/lib/partner-tools";
import { registerTools } from "@/lib/tools";

export const maxDuration = 30;

const serverInfo = { name: "solsol-catalogue", version: "0.2.0" };

// Authenticated endpoint only: withMcpAuth(required: true) below rejects every request that
// doesn't carry a valid SOLSOL partner token, so every server created here can assume req.auth.
// Anonymous callers should use /mcp-public instead.
const partnerHandler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerPartnerTools(server);
  },
  {
    serverInfo,
    instructions:
      "Read-only access to the SOLSOL (solsol.eu) photovoltaic catalogue as the signed-in partner: search_products and get_product include customer-specific prices and availability; get_price and check_availability return price tiers and stock. Ordering is not supported. This endpoint requires signing in with a SOLSOL partner account (OAuth) — anonymous callers should use /mcp-public instead.",
  },
);

function resourceMetadataUrl(req: Request) {
  return `${process.env.MCP_PUBLIC_URL?.replace(/\/+$/, "") || getPublicOrigin(req)}/.well-known/oauth-protected-resource`;
}

/**
 * No Authorization header at all: per RFC 6750 §3, this is a plain "credentials were not provided"
 * case, not an invalid/expired token, so the challenge carries no `error`/`error_description` — only
 * `resource_metadata`, which is what MCP clients use to discover and start the OAuth flow.
 */
function noAuthorizationProvided(req: Request) {
  return new Response(null, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl(req)}"` },
  });
}

function sessionExpired(req: Request) {
  const metadata = resourceMetadataUrl(req);
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "The SOLSOL session has expired" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="The SOLSOL session has expired", resource_metadata="${metadata}"`,
    },
  });
}

async function route(req: Request): Promise<Response> {
  if (req.method !== "POST") return partnerHandler(req);

  // Stateless POSTs complete within the request, so buffer the body: if a tool discovered that the
  // eshop session died (refresh failed), answer 401 so the client re-runs the OAuth login.
  const res = await partnerHandler(req);
  const body = await res.text();
  const sessionId = sessionIdOf(req.auth);
  if (sessionId && consumeExpiredSession(sessionId)) return sessionExpired(req);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// required: true -> requests without a valid bearer token never reach `route`; withMcpAuth answers
// 401 itself. But it labels every such 401 as error="invalid_token", including when no token was
// presented at all — so a missing Authorization header is intercepted here and answered directly,
// before withMcpAuth runs, with a bare `resource_metadata` challenge and no `error`. A header that
// is present but wrong/expired still falls through to withMcpAuth, which correctly reports
// error="invalid_token".
const authenticated = withMcpAuth(route, verifyAccessToken, {
  required: true,
  resourceUrl: process.env.MCP_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
});

async function handler(req: Request): Promise<Response> {
  if (!req.headers.get("authorization")) return noAuthorizationProvided(req);
  return authenticated(req);
}

export { handler as GET, handler as POST, handler as DELETE };
