import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { browseCategory, getProduct, listCategories, searchProducts, SolsolError } from "./solsol";

const NOTE =
  "Public catalogue data only (anonymous eshop view): prices, stock and availability are not included.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof SolsolError ? e.message : `Unexpected error: ${(e as Error).message}` }],
});

async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (e) {
    return fail(e);
  }
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: `Full-text search in the SOLSOL photovoltaic catalogue (inverters, panels, batteries, optimizers, mounting, accessories). Works with product names, model codes ("WIT 50K"), brands, or catalogue numbers. ${NOTE}`,
      inputSchema: z.object({
        query: z.string().min(2).describe('Search text, e.g. "growatt hybrid inverter 10 kW" or "209504"'),
        limit: z.number().int().min(1).max(20).default(10).describe("Max results (1-20)"),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit }) => run(() => searchProducts(query, limit)),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product detail",
      description: `Full product detail: description, technical parameters (power, MPPT, voltage, efficiency ...), images and downloadable documents (datasheets, manuals, declarations). Accepts a catalogue number (e.g. 209504), a product slug, or a full solsol.eu product URL. ${NOTE}`,
      inputSchema: z.object({
        identifier: z.string().min(1).describe('Catalogue number ("209504"), slug ("growatt-wit-50k-hu") or product URL'),
      }),
      annotations: READ_ONLY,
    },
    ({ identifier }) =>
      run(async () => {
        const p = await getProduct(identifier);
        if (!p) throw new SolsolError(`No product found for "${identifier}". Try search_products first.`);
        return p;
      }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description: `Category tree of the eshop (slugs can be passed to browse_category). ${NOTE}`,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => run(() => listCategories()),
  );

  server.registerTool(
    "browse_category",
    {
      title: "Browse category",
      description: `List products in a category, paginated. Use list_categories to find slugs (e.g. "inverters", "batteries", "photovoltaic-panels"). Pass nextCursor from a previous result as "after" to get the next page. ${NOTE}`,
      inputSchema: z.object({
        category: z.string().min(1).describe('Category slug, e.g. "inverters"'),
        limit: z.number().int().min(1).max(30).default(10).describe("Page size (1-30)"),
        after: z.string().optional().describe("Pagination cursor (nextCursor from the previous page)"),
      }),
      annotations: READ_ONLY,
    },
    ({ category, limit, after }) =>
      run(async () => {
        const r = await browseCategory(category, limit, after);
        if (!r) throw new SolsolError(`Category "${category}" not found. Use list_categories for valid slugs.`);
        return r;
      }),
  );
}
