import { EshopUnavailableError, InvalidCredentialsError, eshopLogin } from "../eshop";
import { getClient, redirectUriMatches } from "./clients";
import { issuer, resourceUrl, SCOPE, TTL } from "./config";
import { ConfigError, PKCE_CHALLENGE_RE, randomToken, safeEqual, sha256 } from "./crypto";
import { renderErrorPage, renderLoginPage, type LoginView } from "./login-page";
import { clientIp, getRuntime } from "./runtime";
import { createEshopSession } from "./session";
import { issueAuthorizationCode } from "./tokens";

interface AuthorizeTx {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  resource: string;
  csrfHash: string;
}

const MESSAGES = {
  invalidLogin: "Nesprávný e-mail nebo heslo. / Incorrect email or password.",
  rateLimited: "Příliš mnoho pokusů o přihlášení. Zkuste to prosím za 15 minut. / Too many sign-in attempts, try again in 15 minutes.",
  unavailable: "SOLSOL eshop je dočasně nedostupný. Zkuste to prosím později. / The SOLSOL eshop is temporarily unavailable.",
  expired: "Platnost přihlašovacího odkazu vypršela. Vraťte se do aplikace a začněte znovu. / This sign-in link has expired, start again from your app.",
  csrf: "Bezpečnostní kontrola selhala. Vraťte se do aplikace a začněte znovu. / Security check failed, start again from your app.",
  misconfigured: "Server není správně nakonfigurován. / The server is not configured correctly.",
};

function csrfCookieName(req: Request) {
  return issuer(req).startsWith("https://") ? "__Host-solsol_csrf" : "solsol_csrf";
}

function csrfCookie(req: Request, value: string) {
  const secure = issuer(req).startsWith("https://") || new URL(issuer(req)).hostname === "localhost";
  return `${csrfCookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL.authorizeTx}${secure ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function redirectWith(redirectUri: string, params: Record<string, string>, req: Request) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("iss", issuer(req));
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

const redirectError = (req: Request, redirectUri: string, state: string | null, error: string, description: string) =>
  redirectWith(redirectUri, { error, error_description: description, ...(state ? { state } : {}) }, req);

// ---------- GET /authorize ----------

export async function handleAuthorizeGet(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";

  // Until client_id + redirect_uri are verified we must never redirect (open-redirect protection).
  const client = clientId ? await getClient(clientId) : null;
  if (!client) return renderErrorPage(400, "Neznámá aplikace (client_id). / Unknown client.");
  if (!redirectUri || !redirectUriMatches(redirectUri, client.redirect_uris)) {
    return renderErrorPage(400, "redirect_uri neodpovídá registraci aplikace. / redirect_uri does not match the registered value.");
  }

  const state = p.get("state");
  if (!state || state.length > 1024) return redirectError(req, redirectUri, null, "invalid_request", "state is required");
  if (p.get("response_type") !== "code") {
    return redirectError(req, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported");
  }
  const codeChallenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE_RE.test(codeChallenge)) {
    return redirectError(req, redirectUri, state, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const requestedScopes = (p.get("scope") ?? SCOPE).split(" ").filter(Boolean);
  if (requestedScopes.some((s) => s !== SCOPE)) {
    return redirectError(req, redirectUri, state, "invalid_scope", `Supported scope: ${SCOPE}`);
  }
  const resource = p.get("resource") ?? resourceUrl(req);
  if (resource.replace(/\/$/, "") !== resourceUrl(req)) {
    return redirectError(req, redirectUri, state, "invalid_target", "Unknown resource");
  }

  const txId = randomToken(16);
  const csrf = randomToken(32);
  const tx: AuthorizeTx = {
    clientId,
    clientName: client.client_name ?? new URL(redirectUri).host,
    redirectUri,
    codeChallenge,
    state,
    scope: SCOPE,
    resource: resourceUrl(req),
    csrfHash: sha256(csrf),
  };
  await getRuntime().kv.set(`authz-tx:${txId}`, tx, TTL.authorizeTx);
  return renderLoginPage(viewFor(tx, txId, csrf), 200, { "Set-Cookie": csrfCookie(req, csrf) });
}

const viewFor = (tx: AuthorizeTx, txId: string, csrf: string, extra: Partial<LoginView> = {}): LoginView => ({
  txId,
  csrf,
  clientName: tx.clientName,
  redirectOrigin: new URL(tx.redirectUri).origin,
  ...extra,
});

// ---------- POST /authorize ----------

function isSameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(issuer(req)).origin;
}

export async function handleAuthorizePost(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return renderErrorPage(403, MESSAGES.csrf);
  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const v = form?.get(name);
    return typeof v === "string" ? v : "";
  };
  const txId = field("tx");
  const csrf = field("csrf");
  const { kv, loginLimiter } = getRuntime();

  const tx = txId ? await kv.get<AuthorizeTx>(`authz-tx:${txId}`) : null;
  if (!tx) return renderErrorPage(400, MESSAGES.expired);

  const cookie = readCookie(req, csrfCookieName(req));
  if (!csrf || !cookie || !safeEqual(csrf, cookie) || !safeEqual(sha256(csrf), tx.csrfHash)) {
    return renderErrorPage(403, MESSAGES.csrf);
  }

  if (field("action") === "deny") {
    await kv.del(`authz-tx:${txId}`);
    return redirectError(req, tx.redirectUri, tx.state, "access_denied", "The user denied the request");
  }

  const email = field("email").trim().toLowerCase();
  const password = field("password");
  const again = (status: number, error: string) =>
    renderLoginPage(viewFor(tx, txId, csrf, { email, error }), status);

  if (!email || email.length > 254 || !email.includes("@") || !password || password.length > 512) {
    return again(400, MESSAGES.invalidLogin);
  }

  const [byIp, byEmail] = await Promise.all([
    loginLimiter.limit(`ip:${clientIp(req)}`),
    loginLimiter.limit(`email:${sha256(email)}`),
  ]);
  if (!byIp.success || !byEmail.success) return again(429, MESSAGES.rateLimited);

  let code: string;
  try {
    const eshopTokens = await eshopLogin(email, password);
    const sessionId = await createEshopSession(eshopTokens);
    code = await issueAuthorizationCode({
      clientId: tx.clientId,
      redirectUri: tx.redirectUri,
      codeChallenge: tx.codeChallenge,
      scope: tx.scope,
      resource: tx.resource,
      sessionId,
    });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) return again(401, MESSAGES.invalidLogin);
    if (e instanceof EshopUnavailableError) return again(503, MESSAGES.unavailable);
    if (e instanceof ConfigError) {
      console.error("[solsol-mcp] configuration error:", e.message);
      return again(500, MESSAGES.misconfigured);
    }
    throw e;
  }

  await kv.del(`authz-tx:${txId}`);
  return redirectWith(tx.redirectUri, { code, state: tx.state }, req);
}
