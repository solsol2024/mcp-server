import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { POST } from "../app/mcp/route";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

async function rpc(method: string, params: unknown = {}, id = 1) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await POST(req);
  const text = await res.text();
  // Streamable HTTP may answer as JSON or as a single SSE event.
  const payload = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()
    : text;
  return { status: res.status, body: JSON.parse(payload) };
}

describe("MCP endpoint (real handler, mocked eshop)", () => {
  it("lists the four tools, all read-only", async () => {
    const { body } = await rpc("tools/list");
    const tools = body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["browse_category", "get_product", "list_categories", "search_products"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("search_products end to end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fx("search-wit"), { status: 200 })));
    const { body } = await rpc("tools/call", { name: "search_products", arguments: { query: "wit 50k", limit: 2 } });
    const out = JSON.parse(body.result.content[0].text);
    expect(out.products[0].catalogNumber).toBe("209504");
  });

  it("returns isError for an unknown category", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { category: null } }), { status: 200 })));
    const { body } = await rpc("tools/call", { name: "browse_category", arguments: { category: "nope" } });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not found/i);
  });
});
