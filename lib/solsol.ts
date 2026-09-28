/**
 * Read-only client for the public SOLSOL storefront GraphQL API (Shopsys).
 *
 * Design rules:
 *  - Anonymous access only. Price, stock and availability fields are deliberately
 *    NEVER requested: the eshop hides them from anonymous visitors.
 *  - Query values are inlined with JSON.stringify (valid GraphQL string literal)
 *    and sent via GET so responses can be cached by the platform.
 */

export const GRAPHQL_URL = process.env.SOLSOL_GRAPHQL_URL ?? "https://solsol.eu/graphql/";
export const SITE_URL = (process.env.SOLSOL_SITE_URL ?? "https://solsol.eu").replace(/\/$/, "");
const SEARCH_USER_ID = "00000000-0000-4000-8000-000000000000";

export class SolsolError extends Error {}

// ---------- helpers ----------

/** Accepts "https://solsol.eu/foo", "/foo" or "foo" and returns "foo". */
export function normalizeSlug(input: string): string {
  let s = input.trim();
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    /* fall through */
  }
  s = s.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_/.]*$/.test(s)) {
    throw new SolsolError(`Invalid slug: "${input}"`);
  }
  return s;
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const abs = (path: string | null | undefined) =>
  !path ? null : /^https?:\/\//i.test(path) ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;

async function gql<T>(query: string): Promise<T> {
  const url = `${GRAPHQL_URL}?query=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "solsol-mcp-demo/0.1 (read-only catalogue)" },
      // Next.js data cache: catalogue data changes slowly.
      next: { revalidate: 300 },
    } as RequestInit);
  } catch (e) {
    throw new SolsolError(`Could not reach the eshop: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SolsolError(`Eshop responded with HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new SolsolError(`Eshop GraphQL error: ${body.errors[0].message}`);
  if (!body.data) throw new SolsolError("Eshop returned an empty response");
  return body.data;
}

// ---------- types (what the MCP tools return) ----------

export interface ProductSummary {
  name: string;
  catalogNumber: string | null;
  brand: string | null;
  categories: string[];
  url: string;
  slug: string;
  image: string | null;
}

export interface ProductDetail extends ProductSummary {
  ean: string | null;
  breadcrumb: string[];
  badges: string[];
  description: string;
  parameters: Record<string, string>;
  documents: { title: string; url: string }[];
  images: string[];
}

export interface Category {
  name: string;
  slug: string;
  children: Category[];
}

// ---------- raw GraphQL shapes ----------

interface RawSummary {
  name: string;
  fullName?: string;
  slug: string;
  catalogNumber: string | null;
  brand: { name: string } | null;
  categories: { name: string }[];
  mainImage: { url: string } | null;
}

const SUMMARY_FIELDS = "name fullName slug catalogNumber brand{name} categories{name} mainImage{url}";

export function mapSummary(p: RawSummary): ProductSummary {
  return {
    name: p.fullName || p.name,
    catalogNumber: p.catalogNumber ?? null,
    brand: p.brand?.name ?? null,
    categories: (p.categories ?? []).map((c) => c.name),
    url: abs(p.slug)!,
    slug: p.slug.replace(/^\//, ""),
    image: p.mainImage?.url ?? null,
  };
}

// ---------- queries ----------

export async function searchProducts(query: string, limit = 10) {
  const q = query.trim();
  if (q.length < 2) throw new SolsolError("Search query must have at least 2 characters");
  const first = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const data = await gql<{
    productsSearch: { totalCount: number; edges: { node: RawSummary }[] };
  }>(
    `{productsSearch(searchInput:{search:${JSON.stringify(q)},isAutocomplete:false,userIdentifier:"${SEARCH_USER_ID}"},first:${first}){totalCount edges{node{${SUMMARY_FIELDS}}}}}`,
  );
  return {
    totalCount: data.productsSearch.totalCount,
    products: data.productsSearch.edges.map((e) => mapSummary(e.node)),
  };
}

interface RawProduct extends RawSummary {
  ean: string | null;
  breadcrumb: { name: string }[];
  description: string | null;
  flags: { name: string }[];
  images: { url: string }[];
  files: { anchorText: string; url: string }[];
  parameters: { name: string; visible: boolean; unit: { name: string } | null; values: { text: string }[] }[];
}

const PRODUCT_FIELDS = `${SUMMARY_FIELDS} ean breadcrumb{name} description flags{name} images{url} files{anchorText url} parameters{name visible unit{name} values{text}}`;

export function mapProduct(p: RawProduct): ProductDetail {
  const parameters: Record<string, string> = {};
  for (const par of p.parameters ?? []) {
    if (!par.visible) continue;
    const value = par.values.map((v) => v.text).join(", ");
    parameters[par.name] = par.unit?.name ? `${value} ${par.unit.name}` : value;
  }
  return {
    ...mapSummary(p),
    ean: p.ean ?? null,
    breadcrumb: (p.breadcrumb ?? []).map((b) => b.name),
    badges: (p.flags ?? []).map((f) => f.name),
    description: stripHtml(p.description),
    parameters,
    documents: (p.files ?? []).map((f) => ({ title: f.anchorText, url: abs(f.url)! })),
    images: (p.images ?? []).map((i) => i.url),
  };
}

export async function getProductBySlug(slugOrUrl: string): Promise<ProductDetail | null> {
  const slug = normalizeSlug(slugOrUrl);
  const data = await gql<{ product: RawProduct | null }>(
    `{product(urlSlug:${JSON.stringify(slug)}){${PRODUCT_FIELDS}}}`,
  );
  return data.product ? mapProduct(data.product) : null;
}

/** Resolves a product from a catalogue number (e.g. "209504"), slug or full URL. */
export async function getProduct(identifier: string): Promise<ProductDetail | null> {
  const id = identifier.trim();
  if (/^[0-9A-Za-z]+$/.test(id) && /\d/.test(id) && !id.includes("-")) {
    const found = await searchProducts(id, 10);
    const exact = found.products.find((p) => p.catalogNumber === id);
    if (exact) return getProductBySlug(exact.slug);
  }
  return getProductBySlug(id);
}

export async function listCategories(): Promise<Category[]> {
  const data = await gql<{
    categories: { name: string; slug: string; children: { name: string; slug: string; children: { name: string; slug: string }[] }[] }[];
  }>(`{categories{name slug children{name slug children{name slug}}}}`);
  const map = (c: { name: string; slug: string; children?: any[] }): Category => ({
    name: c.name,
    slug: c.slug.replace(/^\//, ""),
    children: (c.children ?? []).map(map),
  });
  return data.categories.map(map);
}

export async function browseCategory(slugOrUrl: string, limit = 10, after?: string) {
  const slug = normalizeSlug(slugOrUrl);
  const first = Math.min(Math.max(Math.trunc(limit), 1), 30);
  const afterArg = after ? `,after:${JSON.stringify(after)}` : "";
  const data = await gql<{
    category: {
      name: string;
      products: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: { node: RawSummary }[];
      };
    } | null;
  }>(
    `{category(urlSlug:${JSON.stringify(slug)}){name products(first:${first}${afterArg}){totalCount pageInfo{hasNextPage endCursor} edges{node{${SUMMARY_FIELDS}}}}}}`,
  );
  if (!data.category) return null;
  const { products } = data.category;
  return {
    category: data.category.name,
    totalCount: products.totalCount,
    hasNextPage: products.pageInfo.hasNextPage,
    nextCursor: products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null,
    products: products.edges.map((e) => mapSummary(e.node)),
  };
}
