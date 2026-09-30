import { createMcpHandler, getPublicOrigin, withMcpAuth } from "mcp-handler";
import { consumeExpiredSession, sessionIdOf } from "@/lib/oauth/session";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { registerPartnerTools } from "@/lib/partner-tools";
import { registerTools } from "@/lib/tools";

export const maxDuration = 30;

const serverInfo = { name: "solsol-catalogue", version: "0.2.0" };

const publicHandler = createMcpHandler(registerTools, {
  serverInfo,
  instructions:
    "Read-only access to the public SOLSOL (solsol.eu) photovoltaic catalogue. Prices and stock are only visible after signing in with a SOLSOL partner account (OAuth).",
});

const partnerHandler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerPartnerTools(server);
  },
  {
    serverInfo,
    instructions:
      "Read-only access to the SOLSOL (solsol.eu) photovoltaic catalogue as the signed-in partner: search_products and get_product include customer-specific prices and availability; get_price and check_availability return price tiers and stock. Ordering is not supported.",
  },
);

function sessionExpired(req: Request) {
  const metadata = `${process.env.MCP_PUBLIC_URL?.replace(/\/+$/, "") || getPublicOrigin(req)}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "The SOLSOL session has expired" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="The SOLSOL session has expired", resource_metadata="${metadata}"`,
    },
  });
}

async function route(req: Request): Promise<Response> {
  if (!req.auth) return publicHandler(req);
  if (req.method !== "POST") return partnerHandler(req);

  // Stateless POSTs complete within the request, so buffer the body: if a tool discovered that the
  // eshop session died (refresh failed), answer 401 so the client re-runs the OAuth login.
  const res = await partnerHandler(req);
  const body = await res.text();
  const sessionId = sessionIdOf(req.auth);
  if (sessionId && consumeExpiredSession(sessionId)) return sessionExpired(req);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const handler = withMcpAuth(route, verifyAccessToken, {
  required: false,
  resourceUrl: process.env.MCP_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
});

export { handler as GET, handler as POST, handler as DELETE };
