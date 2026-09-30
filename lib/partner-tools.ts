import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withPartnerSession } from "./oauth/session";
import { checkAvailability, getPrice } from "./partner";
import { SolsolError } from "./solsol";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const catalogNumber = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z\-_.]+$/, "Catalogue number may only contain letters, digits, - _ .")
  .describe('SOLSOL catalogue number, e.g. "209504"');

async function run<T>(fn: () => Promise<T>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e instanceof SolsolError ? e.message : "Unexpected error" }],
    };
  }
}

/** Registered only for callers authenticated with a SOLSOL partner account. */
export function registerPartnerTools(server: McpServer) {
  server.registerTool(
    "get_price",
    {
      title: "Get partner price",
      description:
        "Your customer-specific SOLSOL price for a product: price incl. and excl. VAT, VAT amount, currency and quantity price tiers. Requires a signed-in partner account.",
      inputSchema: z.object({ catalogNumber }),
      annotations: READ_ONLY,
    },
    ({ catalogNumber }, ctx) => run(() => withPartnerSession(ctx.http?.authInfo, (store) => getPrice(store, catalogNumber))),
  );

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description:
        "Stock for a product, as visible to your SOLSOL partner account. Only stock.inStockNow (CZ warehouse) is physically in stock and ready to ship. stock.arrivingWithin7Days (NL) and stock.arrivingIn14DaysOrMore (CESTA, on the way) are not in stock yet. When asked about stock, report all three figures separately; never present totalIncludingIncoming as the in-stock quantity.",
      inputSchema: z.object({ catalogNumber }),
      annotations: READ_ONLY,
    },
    ({ catalogNumber }, ctx) =>
      run(() => withPartnerSession(ctx.http?.authInfo, (store) => checkAvailability(store, catalogNumber))),
  );
}
