import { createMcpHandler } from "mcp-handler";
import { registerTools } from "@/lib/tools";

export const maxDuration = 30;

// No authentication: registerTools never sees ctx.http.authInfo here, so results are always the
// anonymous, public-catalogue view (no prices, no stock). Partner sign-in lives at /mcp.
const handler = createMcpHandler(registerTools, {
  serverInfo: { name: "solsol-catalogue-public", version: "0.2.0" },
  instructions:
    "Read-only access to the public SOLSOL (solsol.eu) photovoltaic catalogue: search, product detail, categories and browsing. No prices or stock — sign in with a SOLSOL partner account at the authenticated /mcp endpoint for those.",
});

export { handler as GET, handler as POST, handler as DELETE };
