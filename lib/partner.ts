/**
 * Customer-specific catalogue data (prices, stock). Only ever called with an authenticated
 * eshop session; anonymous code paths in lib/solsol.ts never request these fields.
 */
import { authedQuery, type EshopTokenStore } from "./eshop";
import {
  mapProduct,
  mapSummary,
  normalizeSlug,
  PRODUCT_FIELDS,
  SEARCH_USER_ID,
  SolsolError,
  SUMMARY_FIELDS,
  type RawProduct,
  type RawSummary,
} from "./solsol";

export const COMMERCIAL_FIELDS =
  "price{priceWithVat priceWithoutVat vatAmount isPriceFrom currencyCode minQuantity} quantityPrices{priceWithVat priceWithoutVat currencyCode minQuantity} availability{name status} stockQuantity stockQuantities{name quantity}";

interface RawCommercial {
  price: {
    priceWithVat: string;
    priceWithoutVat: string;
    vatAmount: string;
    isPriceFrom: boolean;
    currencyCode: string;
    minQuantity: number | null;
  } | null;
  quantityPrices: { priceWithVat: string; priceWithoutVat: string; currencyCode: string; minQuantity: number }[] | null;
  availability: { name: string; status: string } | null;
  stockQuantity: number | null;
  stockQuantities: { name: string; quantity: number }[] | null;
}

export function mapPricing(p: RawCommercial) {
  return {
    price: p.price
      ? {
          withVat: p.price.priceWithVat,
          withoutVat: p.price.priceWithoutVat,
          vat: p.price.vatAmount,
          currency: p.price.currencyCode,
          isPriceFrom: p.price.isPriceFrom,
          minQuantity: p.price.minQuantity,
        }
      : null,
    quantityPrices: (p.quantityPrices ?? []).map((q) => ({
      minQuantity: q.minQuantity,
      withVat: q.priceWithVat,
      withoutVat: q.priceWithoutVat,
      currency: q.currencyCode,
    })),
  };
}

export function mapAvailability(p: RawCommercial) {
  return {
    availability: p.availability ? { name: p.availability.name, status: p.availability.status } : null,
    stockQuantity: p.stockQuantity ?? null,
    stockByWarehouse: (p.stockQuantities ?? []).map((s) => ({ warehouse: s.name, quantity: s.quantity })),
  };
}

type RawSummaryWithCommercial = RawSummary & RawCommercial;

export async function partnerSearch(store: EshopTokenStore, query: string, limit = 10) {
  const q = query.trim();
  if (q.length < 2) throw new SolsolError("Search query must have at least 2 characters");
  const first = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const data = await authedQuery<{
    productsSearch: { totalCount: number; edges: { node: RawSummaryWithCommercial }[] };
  }>(
    store,
    "ProductsSearchQuery",
    `query ProductsSearchQuery{productsSearch(searchInput:{search:${JSON.stringify(q)},isAutocomplete:false,userIdentifier:"${SEARCH_USER_ID}"},first:${first}){totalCount edges{node{${SUMMARY_FIELDS} ${COMMERCIAL_FIELDS}}}}}`,
  );
  return {
    totalCount: data.productsSearch.totalCount,
    products: data.productsSearch.edges.map(({ node }) => ({
      ...mapSummary(node),
      price: mapPricing(node).price,
      ...mapAvailability(node),
    })),
  };
}

async function searchByCatalogNumber(store: EshopTokenStore, catalogNumber: string) {
  const id = catalogNumber.trim();
  if (!id) throw new SolsolError("Catalogue number is required");
  const data = await authedQuery<{ productsSearch: { edges: { node: RawSummaryWithCommercial }[] } }>(
    store,
    "ProductsSearchQuery",
    `query ProductsSearchQuery{productsSearch(searchInput:{search:${JSON.stringify(id)},isAutocomplete:false,userIdentifier:"${SEARCH_USER_ID}"},first:10){edges{node{${SUMMARY_FIELDS} ${COMMERCIAL_FIELDS}}}}}`,
  );
  return data.productsSearch.edges.map((e) => e.node).find((n) => n.catalogNumber === id) ?? null;
}

async function findByCatalogNumber(store: EshopTokenStore, catalogNumber: string) {
  const node = await searchByCatalogNumber(store, catalogNumber);
  if (!node) throw new SolsolError(`No product with catalogue number "${catalogNumber.trim()}". Try search_products first.`);
  return node;
}

export async function partnerGetProduct(store: EshopTokenStore, identifier: string) {
  const id = identifier.trim();
  let slug = id;
  if (/^[0-9A-Za-z]+$/.test(id) && /\d/.test(id) && !id.includes("-")) {
    const node = await searchByCatalogNumber(store, id);
    if (node) slug = node.slug.replace(/^\//, "");
  }
  const data = await authedQuery<{ product: (RawProduct & RawCommercial) | null }>(
    store,
    "ProductDetailQuery",
    `query ProductDetailQuery{product(urlSlug:${JSON.stringify(normalizeSlug(slug))}){${PRODUCT_FIELDS} ${COMMERCIAL_FIELDS}}}`,
  );
  if (!data.product) return null;
  return { ...mapProduct(data.product), ...mapPricing(data.product), ...mapAvailability(data.product) };
}

export async function getPrice(store: EshopTokenStore, catalogNumber: string) {
  const node = await findByCatalogNumber(store, catalogNumber);
  const s = mapSummary(node);
  return { catalogNumber: s.catalogNumber, name: s.name, url: s.url, ...mapPricing(node) };
}

export async function checkAvailability(store: EshopTokenStore, catalogNumber: string) {
  const node = await findByCatalogNumber(store, catalogNumber);
  const s = mapSummary(node);
  return { catalogNumber: s.catalogNumber, name: s.name, url: s.url, ...mapAvailability(node) };
}
