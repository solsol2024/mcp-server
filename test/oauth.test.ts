import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/oauth/metadata";
import { handleLogout } from "../lib/oauth/tokens";
import { setRuntime } from "../lib/oauth/runtime";
import { authedQuery, SessionExpiredError, type EshopTokens } from "../lib/eshop";
import {
  EMAIL,
  fakeEshop,
  mcp,
  mcpPublic,
  ORIGIN,
  PASSWORD,
  pkcePair,
  REDIRECT,
  registerClient,
  setupRuntime,
  signIn,
  startAuthorize,
  submitLogin,
  tokenRequest,
} from "./helpers";

let kv: ReturnType<typeof setupRuntime>;

beforeEach(() => {
  kv = setupRuntime();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRuntime(null);
});

const toolText = (body: any) => JSON.parse(body.result.content[0].text);

describe("metadata", () => {
  it("publishes authorization server metadata with PKCE S256, DCR and CIMD", async () => {
    const m = await authorizationServerMetadata(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(m).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
  });

  it("publishes protected resource metadata for /mcp", async () => {
    const m = await protectedResourceMetadata(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`)).json();
    expect(m).toEqual({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });
});

describe("client registration and /authorize validation", () => {
  it("accepts https and localhost callbacks, rejects plain http", async () => {
    expect((await registerClient(["https://a.example/cb", "http://localhost:8080/cb"])).res.status).toBe(201);
    const bad = await registerClient(["http://evil.example/cb"]);
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toBe("invalid_redirect_uri");
  });

  it("wrong redirect_uri: error page, never redirects", async () => {
    const { body: client } = await registerClient();
    const { res, html } = await startAuthorize(client.client_id, pkcePair().challenge, {
      redirect_uri: "https://attacker.example/steal",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain("redirect_uri");
  });

  it("loopback redirect_uri matches on any port (RFC 8252 §7.3), other parts must still match", async () => {
    const { body: client } = await registerClient(["http://localhost/callback", "http://127.0.0.1:3118/callback"]);
    const status = async (redirect_uri: string) =>
      (await startAuthorize(client.client_id, pkcePair().challenge, { redirect_uri })).res.status;
    expect(await status("http://localhost:8765/callback")).toBe(200);
    expect(await status("http://localhost/callback")).toBe(200);
    expect(await status("http://127.0.0.1:54321/callback")).toBe(200);
    expect(await status("http://localhost:8765/other")).toBe(400);
    expect(await status("http://127.0.0.1:8765/callback?x=1")).toBe(400);
    expect(await status("http://[::1]:8765/callback")).toBe(400);
  });

  it("https redirect_uri still requires an exact match, port included", async () => {
    const { body: client } = await registerClient(["https://a.example/cb"]);
    const { res } = await startAuthorize(client.client_id, pkcePair().challenge, { redirect_uri: "https://a.example:8443/cb" });
    expect(res.status).toBe(400);
  });

  it("requires PKCE S256", async () => {
    const { body: client } = await registerClient();
    const { res } = await startAuthorize(client.client_id, pkcePair().challenge, { code_challenge_method: "plain" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("client-state-123");
  });

  it("serves the login form under a strict CSP with the required notice", async () => {
    const { body: client } = await registerClient();
    const { res, html, cookie } = await startAuthorize(client.client_id, pkcePair().challenge);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://client.example");
    expect(csp).not.toMatch(/script-src/);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("You are signing in to your SOLSOL partner account. Your password is sent to SOLSOL and is not stored.");
    expect(cookie).toMatch(/^solsol_csrf=/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });
});

describe("login (POST /authorize)", () => {
  it("issues a code bound to state, never stores the password or plaintext eshop tokens", async () => {
    const eshop = fakeEshop();
    const { body: client } = await registerClient();
    const flow = await startAuthorize(client.client_id, pkcePair().challenge);
    const res = await submitLogin(flow);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("client-state-123");
    expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    const stored = JSON.stringify(kv.dump());
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(eshop.access);
    expect(stored).not.toContain(eshop.refresh);
    expect(stored).not.toContain(EMAIL);
  });

  it("uses the same generic message for a wrong password and an unknown email", async () => {
    fakeEshop();
    const { body: client } = await registerClient();
    const flow = await startAuthorize(client.client_id, pkcePair().challenge);
    const wrongPw = await submitLogin(flow, EMAIL, "nope");
    const unknown = await submitLogin(flow, "nobody@example.test", "nope");
    const msg = (html: string) => html.match(/role="alert">([^<]+)</)?.[1];
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(msg(await wrongPw.text())).toBe(msg(await unknown.text()));
  });

  it("login page uses a referrer policy that keeps Origin on its own form POST", async () => {
    const { body: client } = await registerClient();
    const { res } = await startAuthorize(client.client_id, pkcePair().challenge);
    // "no-referrer" makes browsers send `Origin: null`, which the same-origin check rejects.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("rejects missing CSRF cookie and cross-origin posts", async () => {
    const eshop = fakeEshop();
    const { body: client } = await registerClient();
    const flow = await startAuthorize(client.client_id, pkcePair().challenge);
    expect((await submitLogin({ ...flow, cookie: "" })).status).toBe(403);
    expect((await submitLogin(flow, EMAIL, PASSWORD, { origin: "https://evil.example" })).status).toBe(403);
    expect((await submitLogin({ ...flow, csrf: "forged" })).status).toBe(403);
    expect(eshop.loginCalls).toBe(0);
  });

  it("rate limits per IP: 6th attempt within 15 min is refused without calling the eshop", async () => {
    const eshop = fakeEshop();
    const { body: client } = await registerClient();
    const flow = await startAuthorize(client.client_id, pkcePair().challenge);
    for (let i = 0; i < 5; i++) {
      expect((await submitLogin(flow, `user${i}@example.test`, "wrong")).status).toBe(401);
    }
    const blocked = await submitLogin(flow, "user9@example.test", "wrong");
    expect(blocked.status).toBe(429);
    expect(eshop.loginCalls).toBe(5);
  });

  it("rate limits per email across different IPs", async () => {
    const eshop = fakeEshop();
    const { body: client } = await registerClient();
    const flow = await startAuthorize(client.client_id, pkcePair().challenge);
    for (let i = 0; i < 5; i++) {
      await submitLogin(flow, EMAIL, "wrong", { "x-forwarded-for": `198.51.100.${i}` });
    }
    const blocked = await submitLogin(flow, EMAIL, PASSWORD, { "x-forwarded-for": "198.51.100.99" });
    expect(blocked.status).toBe(429);
    expect(eshop.loginCalls).toBe(5);
  });
});

describe("POST /token", () => {
  async function codeFor() {
    fakeEshop();
    const { body: client } = await registerClient();
    const pkce = pkcePair();
    const flow = await startAuthorize(client.client_id, pkce.challenge);
    const login = await submitLogin(flow);
    const code = new URL(login.headers.get("location")!).searchParams.get("code")!;
    return { clientId: client.client_id as string, code, ...pkce };
  }

  it("PKCE failure: wrong code_verifier is rejected and burns the code", async () => {
    const { clientId, code, verifier } = await codeFor();
    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId };
    const bad = await tokenRequest({ ...base, code_verifier: pkcePair().verifier });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");
    expect((await tokenRequest({ ...base, code_verifier: verifier })).body.error).toBe("invalid_grant");
  });

  it("wrong redirect_uri at the token endpoint is rejected", async () => {
    const { clientId, code, verifier } = await codeFor();
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.example/other",
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("code reuse: second exchange fails and revokes tokens from the first", async () => {
    const { clientId, code, verifier } = await codeFor();
    const params = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    const first = await tokenRequest(params);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect((await mcp("tools/list", {}, first.body.access_token)).status).toBe(200);

    const replay = await tokenRequest(params);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcp("tools/list", {}, first.body.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens and treats reuse of an old one as theft", async () => {
    fakeEshop();
    const { clientId, tokens } = await signIn();
    const rotated = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token);

    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await mcp("tools/list", {}, rotated.body.access_token)).status).toBe(401);
  });
});

describe("/mcp-public (anonymous)", () => {
  it("serves public tools only, no eshop auth headers, and ignores bearer tokens", async () => {
    const eshop = fakeEshop();
    const list = await mcpPublic("tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: any) => t.name).sort()).toEqual([
      "browse_category",
      "get_product",
      "list_categories",
      "search_products",
    ]);
    await mcpPublic("tools/call", { name: "search_products", arguments: { query: "wit" } });
    expect(eshop.anonymousCalls).toBe(1);
    expect(eshop.authedCalls).toHaveLength(0);
  });
});

describe("/mcp (authentication required)", () => {
  it("with no Authorization header: 401, resource_metadata only, no error/error_description (RFC 6750 §3)", async () => {
    const res = await mcp("tools/list");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toMatch(/^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"$/);
    expect(challenge).not.toContain("error=");
    expect(challenge).not.toContain("error_description=");
  });

  it("with an invalid bearer token: 401, error=\"invalid_token\" plus resource_metadata", async () => {
    const res = await mcp("tools/list", {}, "not-a-real-token");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("resource_metadata=");
  });

  it("a valid bearer token gets 200 with the full partner tool set", async () => {
    fakeEshop();
    const { tokens } = await signIn();
    const res = await mcp("tools/list", {}, tokens.access_token);
    expect(res.status).toBe(200);
    expect(res.body.result.tools.map((t: any) => t.name).sort()).toEqual([
      "browse_category",
      "check_availability",
      "get_price",
      "get_product",
      "list_categories",
      "search_products",
    ]);
  });

  it("authenticated callers get get_price / check_availability using X-Auth-Token", async () => {
    const eshop = fakeEshop();
    const { tokens } = await signIn();

    const list = await mcp("tools/list", {}, tokens.access_token);
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["get_price", "check_availability"]));

    const price = await mcp("tools/call", { name: "get_price", arguments: { catalogNumber: "209504" } }, tokens.access_token);
    expect(toolText(price.body)).toMatchObject({
      catalogNumber: "209504",
      price: { withVat: "121000.00", withoutVat: "100000.00", currency: "CZK" },
      quantityPrices: [{ minQuantity: 1 }, { minQuantity: 5, withoutVat: "95000.00" }],
    });
    const stock = await mcp("tools/call", { name: "check_availability", arguments: { catalogNumber: "209504" } }, tokens.access_token);
    expect(toolText(stock.body)).toMatchObject({ availability: { status: "InStock" }, stockQuantity: 12 });

    const search = await mcp("tools/call", { name: "search_products", arguments: { query: "wit" } }, tokens.access_token);
    expect(toolText(search.body).products[0].price.withoutVat).toBe("100000.00");

    expect(eshop.authedCalls[0].path).toBe("/cs/graphql/ProductsSearchQuery");
    expect(eshop.authedCalls.every((c) => c.xAuthToken === "Bearer eshop-access-1" && c.authorization === null)).toBe(true);
  });

  it("eshop 401 -> refresh -> retry, and the rotated pair is stored", async () => {
    const eshop = fakeEshop();
    const { tokens } = await signIn();
    eshop.expireAccessToken();
    // The eshop now rejects eshop-access-1; the vault still holds it.
    const res = await mcp("tools/call", { name: "get_price", arguments: { catalogNumber: "209504" } }, tokens.access_token);
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    expect(eshop.refreshCalls).toBe(1);
    expect(eshop.authedCalls.map((c) => c.xAuthToken)).toEqual(["Bearer eshop-access-1", "Bearer eshop-access-2"]);

    await mcp("tools/call", { name: "get_price", arguments: { catalogNumber: "209504" } }, tokens.access_token);
    expect(eshop.refreshCalls).toBe(1);
    expect(eshop.authedCalls.at(-1)!.xAuthToken).toBe("Bearer eshop-access-2");
  });

  it("refresh failure -> HTTP 401 auth error, session revoked so the client must log in again", async () => {
    const eshop = fakeEshop();
    const { tokens } = await signIn();
    eshop.expireAccessToken();
    eshop.refreshWorks = false;
    const res = await mcp("tools/call", { name: "get_price", arguments: { catalogNumber: "209504" } }, tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/invalid_token.*resource_metadata=/);
    expect((await mcp("tools/list", {}, tokens.access_token)).status).toBe(401);
  });

  it("/logout revokes the MCP token and deletes the stored eshop tokens", async () => {
    fakeEshop();
    const { tokens } = await signIn();
    const before = Object.keys(kv.dump()).filter((key) => key.startsWith("eshop:"));
    expect(before).toHaveLength(1);
    const res = await handleLogout(
      new Request(`${ORIGIN}/logout`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } }),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(kv.dump()).filter((key) => key.startsWith("eshop:"))).toHaveLength(0);
    expect((await mcp("tools/list", {}, tokens.access_token)).status).toBe(401);
  });
});

describe("authedQuery (unit)", () => {
  const memoryStore = (initial: EshopTokens) => {
    let current: EshopTokens | null = initial;
    return { load: async () => current, save: async (t: EshopTokens) => void (current = t), get: () => current };
  };

  it("retries once after refreshing on 401", async () => {
    const eshop = fakeEshop();
    const store = memoryStore({ accessToken: "stale", refreshToken: eshop.refresh });
    const data = await authedQuery<any>(store, "ProductsSearchQuery", "query ProductsSearchQuery{productsSearch{totalCount}}");
    expect(data.productsSearch.totalCount).toBe(1);
    expect(store.get()).toEqual({ accessToken: "eshop-access-2", refreshToken: "eshop-refresh-2" });
  });

  it("throws SessionExpiredError when refresh fails", async () => {
    const eshop = fakeEshop();
    eshop.refreshWorks = false;
    const store = memoryStore({ accessToken: "stale", refreshToken: eshop.refresh });
    await expect(authedQuery(store, "ProductsSearchQuery", "query ProductsSearchQuery{x}")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
