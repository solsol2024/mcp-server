/**
 * Authenticated client for the SOLSOL Shopsys Storefront GraphQL API.
 * Operations are POSTed to /<locale>/graphql/<OperationName> with `X-Auth-Token: Bearer <token>`.
 * Never log tokens, passwords or response bodies from this module.
 */
import { SITE_URL, SolsolError } from "./solsol";

export const LOCALE = (process.env.SOLSOL_LOCALE ?? "cs").replace(/[^a-z-]/gi, "") || "cs";

export class InvalidCredentialsError extends SolsolError {}
export class EshopUnavailableError extends SolsolError {}
export class SessionExpiredError extends SolsolError {}

export interface EshopTokens {
  accessToken: string;
  refreshToken: string;
}

export interface EshopTokenStore {
  load(): Promise<EshopTokens | null>;
  save(tokens: EshopTokens): Promise<void>;
}

const LOGIN_MUTATION = `mutation LoginMutation(
    $email: String!, $password: Password!, $previousCartUuid: Uuid,
    $productListsUuids: [Uuid!]!, $shouldOverwriteCustomerUserCart: Boolean = false
  ) {
    Login(input: {
      email: $email, password: $password, cartUuid: $previousCartUuid,
      productListsUuids: $productListsUuids,
      shouldOverwriteCustomerUserCart: $shouldOverwriteCustomerUserCart
    }) { tokens { accessToken refreshToken } showCartMergeInfo }
  }`;

const REFRESH_MUTATION = `mutation RefreshTokens($refreshToken: String!) {
    RefreshTokens(input: { refreshToken: $refreshToken }) { accessToken refreshToken }
  }`;

export const operationUrl = (operationName: string) => `${SITE_URL}/${LOCALE}/graphql/${operationName}`;

async function post(operationName: string, query: string, variables: Record<string, unknown>, accessToken?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "solsol-mcp/0.2 (partner read-only)",
  };
  if (accessToken) headers["X-Auth-Token"] = `Bearer ${accessToken}`;
  try {
    return await fetch(operationUrl(operationName), {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
  } catch {
    throw new EshopUnavailableError("Could not reach the SOLSOL eshop");
  }
}

const readJson = async (res: Response) =>
  (await res.json().catch(() => null)) as { data?: Record<string, any>; errors?: { message: string }[] } | null;

const isTokenPair = (t: any): t is EshopTokens =>
  typeof t?.accessToken === "string" && typeof t?.refreshToken === "string" && t.accessToken && t.refreshToken;

/** Throws InvalidCredentialsError for any rejected login, without distinguishing unknown emails. */
export async function eshopLogin(email: string, password: string): Promise<EshopTokens> {
  const res = await post("LoginMutation", LOGIN_MUTATION, { email, password, productListsUuids: [] });
  if (res.status >= 500) throw new EshopUnavailableError("The SOLSOL eshop is temporarily unavailable");
  const tokens = (await readJson(res))?.data?.Login?.tokens;
  if (!res.ok || !isTokenPair(tokens)) throw new InvalidCredentialsError("Invalid email or password");
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

export async function eshopRefresh(refreshToken: string): Promise<EshopTokens> {
  const res = await post("RefreshTokens", REFRESH_MUTATION, { refreshToken });
  if (res.status >= 500) throw new EshopUnavailableError("The SOLSOL eshop is temporarily unavailable");
  const tokens = (await readJson(res))?.data?.RefreshTokens;
  if (!res.ok || !isTokenPair(tokens)) throw new SessionExpiredError("Your SOLSOL session has expired. Please sign in again.");
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

async function refreshAndStore(store: EshopTokenStore, current: EshopTokens): Promise<EshopTokens> {
  try {
    const next = await eshopRefresh(current.refreshToken);
    await store.save(next);
    return next;
  } catch (e) {
    if (!(e instanceof SessionExpiredError)) throw e;
    // A concurrent request may have rotated the refresh token already.
    const latest = await store.load();
    if (latest && latest.refreshToken !== current.refreshToken) return latest;
    throw e;
  }
}

/** Runs an authenticated operation; on HTTP 401 refreshes the eshop tokens once and retries. */
export async function authedQuery<T>(
  store: EshopTokenStore,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let tokens = await store.load();
  if (!tokens) throw new SessionExpiredError("Your SOLSOL session has expired. Please sign in again.");

  let res = await post(operationName, query, variables, tokens.accessToken);
  if (res.status === 401) {
    tokens = await refreshAndStore(store, tokens);
    res = await post(operationName, query, variables, tokens.accessToken);
    if (res.status === 401) throw new SessionExpiredError("Your SOLSOL session has expired. Please sign in again.");
  }
  if (!res.ok) throw new SolsolError(`Eshop responded with HTTP ${res.status}`);
  const body = await readJson(res);
  if (body?.errors?.length) throw new SolsolError(`Eshop GraphQL error: ${body.errors[0].message}`);
  if (!body?.data) throw new SolsolError("Eshop returned an empty response");
  return body.data as T;
}
