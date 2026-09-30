import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { browseCategory, getProduct, listCategories, normalizeSlug, searchProducts, stripHtml } from "../lib/solsol";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

/** Routes a mocked fetch by a substring of the decoded GraphQL query. */
function mockEshop(routes: Record<string, string>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
      calls.push(q);
      const key = Object.keys(routes).find((k) => q.includes(k));
      if (!key) return new Response(JSON.stringify({ errors: [{ message: `unmocked: ${q}` }] }), { status: 200 });
      return new Response(routes[key], { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("helpers", () => {
  it("normalizes slugs, paths and URLs", () => {
    expect(normalizeSlug("https://solsol.eu/growatt-wit-50k-hu")).toBe("growatt-wit-50k-hu");
    expect(normalizeSlug("/inverters")).toBe("inverters");
    expect(normalizeSlug("inverters/")).toBe("inverters");
  });
  it("rejects malformed slugs", () => {
    expect(() => normalizeSlug('a"b')).toThrow();
    expect(() => normalizeSlug("")).toThrow();
  });
  it("strips HTML", () => {
    expect(stripHtml("<p><strong>A</strong></p><p>B&nbsp;&amp; C<br></p>")).toBe("A\nB & C");
  });
});

describe("eshop client", () => {
  it("searchProducts maps results", async () => {
    mockEshop({ productsSearch: fx("search-wit") });
    const r = await searchProducts("wit 50k", 5);
    expect(r.totalCount).toBe(8);
    expect(r.products[0]).toMatchObject({
      name: "Growatt WIT 50K-HU",
      catalogNumber: "209504",
      brand: "Growatt",
      url: "https://solsol.eu/growatt-wit-50k-hu",
      slug: "growatt-wit-50k-hu",
    });
    expect(r.products[1].image).toBeNull();
  });

  it("escapes hostile search input inside the GraphQL string", async () => {
    const calls = mockEshop({ productsSearch: fx("search-wit") });
    await searchProducts('x"}){__typename}#', 3);
    expect(calls[0]).toContain('search:"x\\"}){__typename}#"');
  });

  it("never requests price or stock fields", async () => {
    const calls = mockEshop({ productsSearch: fx("search-wit"), "product(": fx("product") });
    await searchProducts("wit", 3);
    await getProduct("growatt-wit-50k-hu");
    for (const q of calls) expect(q).not.toMatch(/price|stock|availability|quantit/i);
  });

  it("getProduct by slug returns cleaned detail", async () => {
    mockEshop({ "product(": fx("product") });
    const p = (await getProduct("https://solsol.eu/growatt-wit-50k-hu"))!;
    expect(p.parameters).toEqual({
      Category: "Commercial",
      "AC nominal power": "50000 W",
      "Inverter type": "Hybrid",
      "MPPT voltage Max": "800 V",
      "No. of MPPT": "7",
    }); // hidden parameter excluded, units appended
    expect(p.description).toContain("Commercial hybrid inverter WIT 50K-HU");
    expect(p.description).not.toContain("<");
    expect(p.documents[0]).toEqual({
      title: "Product List",
      url: "https://solsol.eu/file/view/3903/growatt_ds_wit_50-100k_hu_datasheet_en_20260316_en.pdf",
    });
    expect(p.badges).toEqual(["10-year warranty included"]);
    expect(p.breadcrumb).toEqual(["Inverters", "Growatt WIT 50K-HU"]);
  });

  it("getProduct resolves a catalogue number via search, then slug", async () => {
    const calls = mockEshop({ productsSearch: fx("search-209504"), "product(": fx("product") });
    const p = await getProduct("209504");
    expect(p?.name).toBe("Growatt WIT 50K-HU");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('product(urlSlug:"growatt-wit-50k-hu")');
  });

  it("getProduct returns null for unknown product", async () => {
    mockEshop({ "product(": JSON.stringify({ data: { product: null } }) });
    expect(await getProduct("does-not-exist")).toBeNull();
  });

  it("listCategories strips leading slashes and keeps nesting", async () => {
    mockEshop({ categories: fx("categories") });
    const c = await listCategories();
    expect(c.map((x) => x.slug)).toEqual(["batteries", "photovoltaic-panels", "accessories", "inverters"]);
    expect(c[2].children.map((x) => x.slug)).toEqual(["cables", "connectors"]);
  });

  it("browseCategory paginates with cursor", async () => {
    const calls = mockEshop({ "category(": fx("category-inverters") });
    const r = (await browseCategory("/inverters", 1, "YXJyYXljb25uZWN0aW9uOjI="))!;
    expect(calls[0]).toContain('after:"YXJyYXljb25uZWN0aW9uOjI="');
    expect(r).toMatchObject({ category: "Inverters", totalCount: 205, hasNextPage: true, nextCursor: "YXJyYXljb25uZWN0aW9uOjQ=" });
    expect(r.products).toHaveLength(1);
  });

  it("browseCategory returns null for unknown category", async () => {
    mockEshop({ "category(": JSON.stringify({ data: { category: null } }) });
    expect(await browseCategory("nope")).toBeNull();
  });

  it("surfaces GraphQL and HTTP errors", async () => {
    mockEshop({ productsSearch: JSON.stringify({ errors: [{ message: "boom" }] }) });
    await expect(searchProducts("wit", 3)).rejects.toThrow(/boom/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 503 })));
    await expect(listCategories()).rejects.toThrow(/503/);
  });
});
