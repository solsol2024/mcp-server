import { randomBytes, createHash } from "node:crypto";
import { vi } from "vitest";
import { memoryKV, memoryLimiter, setRuntime } from "../lib/oauth/runtime";
import { handleRegister } from "../lib/oauth/clients";
import { handleAuthorizeGet, handleAuthorizePost } from "../lib/oauth/authorize";
import { handleToken } from "../lib/oauth/tokens";
import { POST as mcpPost } from "../app/mcp/route";

export const ORIGIN = "http://localhost";
export const REDIRECT = "https://client.example/callback";
// Fake credentials for the mocked eshop only.
export const EMAIL = "partner@example.test";
export const PASSWORD = "fake-password-for-tests";

export function setupRuntime() {
  process.env.MCP_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const kv = memoryKV();
  setRuntime({
    kv,
    loginLimiter: memoryLimiter(5, 15 * 60 * 1000),
    registerLimiter: memoryLimiter(1000, 60 * 60 * 1000),
  });
  return kv;
}

const authedProduct = {
  name: "WIT 50K-HU",
  fullName: "Growatt WIT 50K-HU",
  slug: "/growatt-wit-50k-hu",
  catalogNumber: "209504",
  brand: { name: "Growatt" },
  categories: [{ name: "Inverters" }],
  mainImage: null,
  price: {
    priceWithVat: "121000.00",
    priceWithoutVat: "100000.00",
    vatAmount: "21000.00",
    isPriceFrom: false,
    currencyCode: "CZK",
    minQuantity: 1,
  },
  quantityPrices: [
    { priceWithVat: "121000.00", priceWithoutVat: "100000.00", currencyCode: "CZK", minQuantity: 1 },
    { priceWithVat: "114950.00", priceWithoutVat: "95000.00", currencyCode: "CZK", minQuantity: 5 },
  ],
  availability: { name: "Skladem", status: "InStock" },
  stockQuantity: 12,
  stockQuantities: [{ name: "Praha", quantity: 12 }],
};

/**
 * Mocked SOLSOL eshop. Tracks the current token pair, rotates on refresh and returns 401
 * for stale access tokens, exactly like the real Storefront API contract.
 */
export function fakeEshop() {
  const state = {
    access: "eshop-access-1",
    refresh: "eshop-refresh-1",
    generation: 1,
    refreshWorks: true,
    loginCalls: 0,
    refreshCalls: 0,
    authedCalls: [] as { path: string; xAuthToken: string | null; authorization: string | null; body: string }[],
    anonymousCalls: 0,
    expireAccessToken() {
      state.access = `expired-${state.generation}`;
    },
  };

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const vars = body ? JSON.parse(body).variables ?? {} : {};

    if (url.pathname === "/cs/graphql/LoginMutation") {
      state.loginCalls++;
      if (vars.email === EMAIL && vars.password === PASSWORD) {
        return reply({ data: { Login: { tokens: { accessToken: state.access, refreshToken: state.refresh }, showCartMergeInfo: false } } });
      }
      return reply({ errors: [{ message: "Log in failed." }], data: { Login: null } });
    }
    if (url.pathname === "/cs/graphql/RefreshTokens") {
      state.refreshCalls++;
      if (!state.refreshWorks || vars.refreshToken !== state.refresh) {
        return reply({ errors: [{ message: "Invalid refresh token" }] });
      }
      state.generation++;
      state.access = `eshop-access-${state.generation}`;
      state.refresh = `eshop-refresh-${state.generation}`;
      return reply({ data: { RefreshTokens: { accessToken: state.access, refreshToken: state.refresh } } });
    }
    if (url.pathname.startsWith("/cs/graphql/")) {
      const xAuthToken = headers.get("x-auth-token");
      state.authedCalls.push({ path: url.pathname, xAuthToken, authorization: headers.get("authorization"), body });
      if (xAuthToken !== `Bearer ${state.access}`) return reply({ message: "Token is expired" }, 401);
      const query: string = JSON.parse(body).query;
      if (query.includes("productsSearch")) {
        return reply({ data: { productsSearch: { totalCount: 1, edges: [{ node: authedProduct }] } } });
      }
      return reply({ data: { product: null } });
    }
    state.anonymousCalls++;
    return reply({ data: { productsSearch: { totalCount: 0, edges: [] } } });
  });

  vi.stubGlobal("fetch", fetchMock);
  return state;
}

export const pkcePair = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export async function registerClient(redirectUris = [REDIRECT]) {
  const res = await handleRegister(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test Client", redirect_uris: redirectUris }),
    }),
  );
  return { res, body: (await res.json()) as Record<string, any> };
}

export function authorizeUrl(params: Record<string, string>) {
  return `${ORIGIN}/authorize?${new URLSearchParams(params)}`;
}

export async function startAuthorize(clientId: string, challenge: string, overrides: Record<string, string> = {}) {
  const res = await handleAuthorizeGet(
    new Request(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "client-state-123",
        ...overrides,
      }),
    ),
  );
  const html = await res.text();
  const tx = html.match(/name="tx" value="([^"]+)"/)?.[1] ?? "";
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { res, html, tx, csrf, cookie };
}

export async function submitLogin(
  flow: { tx: string; csrf: string; cookie: string },
  email = EMAIL,
  password = PASSWORD,
  headers: Record<string, string> = {},
) {
  return handleAuthorizePost(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: flow.cookie,
        origin: ORIGIN,
        "x-forwarded-for": "203.0.113.7",
        ...headers,
      },
      body: new URLSearchParams({ tx: flow.tx, csrf: flow.csrf, email, password, action: "login" }),
    }),
  );
}

export async function tokenRequest(params: Record<string, string>) {
  const res = await handleToken(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Full happy path: register, authorize, log in, exchange the code. */
export async function signIn() {
  const { body: client } = await registerClient();
  const { verifier, challenge } = pkcePair();
  const flow = await startAuthorize(client.client_id, challenge);
  const login = await submitLogin(flow);
  const code = new URL(login.headers.get("location")!).searchParams.get("code")!;
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  return { clientId: client.client_id as string, code, verifier, tokens: tokens.body };
}

export async function mcp(method: string, params: unknown = {}, bearer?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await mcpPost(
    new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
  );
  const text = await res.text();
  const payload = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim() : text;
  return { status: res.status, headers: res.headers, body: payload ? JSON.parse(payload) : null };
}
