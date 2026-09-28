import { createMcpHandler } from "mcp-handler";
import { registerTools } from "@/lib/tools";

export const maxDuration = 30;

const handler = createMcpHandler(registerTools, {
  serverInfo: { name: "solsol-catalogue", version: "0.1.0" },
  instructions:
    "Read-only access to the public SOLSOL (solsol.eu) photovoltaic catalogue. Prices and stock are only visible to logged-in partners and are not available through this server.",
});

export { handler as GET, handler as POST, handler as DELETE };
