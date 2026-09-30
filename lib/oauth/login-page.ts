import { randomToken } from "./crypto";

/**
 * Server-rendered HTML with zero JavaScript, so the page can run under a strict CSP
 * (no scripts at all, nonce-bound inline styles, no third-party origins).
 * Colours mirror the SOLSOL brand tokens (brand/tokens.css).
 */

export interface LoginView {
  txId: string;
  csrf: string;
  clientName: string;
  redirectOrigin: string;
  email?: string;
  error?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLES = `
:root{--sol-navy:#00386B;--sol-navy-800:#0D599E;--sol-navy-100:#D7DEE2;--sol-navy-50:#EAF2FA;
--sol-green-500:#A1C268;--sol-green-600:#85AA45;--sol-yellow-500:#DBE442;--sol-ink:#25283D;
--sol-grey-600:#727588;--sol-grey-50:#FAFBFC;--sol-red-700:#D6171C;--sol-red-50:#FDECEC;--sol-white:#FFFFFF}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
background:var(--sol-grey-50);color:var(--sol-navy);font-family:Roboto,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5}
main{width:100%;max-width:420px;background:var(--sol-white);border:1px solid var(--sol-navy-100);
border-radius:4px 40px 4px 4px;overflow:hidden;box-shadow:0 1px 2px rgba(0,56,107,.06),0 8px 24px rgba(0,56,107,.08)}
.line{height:4px;background:linear-gradient(90deg,var(--sol-green-500) 0 75%,var(--sol-yellow-500) 75% 100%)}
.body{display:flex;flex-direction:column;gap:20px;padding:32px}
.brand{font-weight:700;letter-spacing:.14em;font-size:14px;color:var(--sol-navy);margin:0}
h1{font-weight:200;font-size:28px;line-height:1.2;margin:0}
.lead{margin:0;color:var(--sol-ink)}
.lead strong{font-weight:500}
form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:14px;font-weight:500;color:var(--sol-navy)}
input[type=email],input[type=password]{height:44px;padding:0 12px;border:1px solid var(--sol-navy-100);border-radius:4px;
background:var(--sol-navy-50);color:var(--sol-ink);font:inherit}
input:focus-visible,button:focus-visible{outline:3px solid var(--sol-navy-800);outline-offset:2px}
.actions{display:flex;flex-direction:column;gap:8px;margin-top:4px}
button{min-height:44px;border-radius:4px;font:inherit;font-weight:500;cursor:pointer;padding:0 16px}
.primary{background:var(--sol-green-500);color:var(--sol-navy);border:1px solid var(--sol-green-600)}
.primary:hover{background:var(--sol-green-600)}
.secondary{background:transparent;color:var(--sol-navy);border:1px solid var(--sol-navy-100)}
.secondary:hover{background:var(--sol-navy-50)}
.notice{margin:0;padding:12px 16px;background:var(--sol-navy-50);border-left:3px solid var(--sol-navy);font-size:14px;color:var(--sol-ink)}
.notice p{margin:0}
.notice p+p{margin-top:4px;color:var(--sol-grey-600)}
.error{margin:0;padding:12px 16px;background:var(--sol-red-50);color:var(--sol-red-700);border-radius:4px;font-size:14px}
.meta{margin:0;font-size:13px;color:var(--sol-grey-600)}
`;

function page(title: string, body: string, status: number, formAction: string[], headers: Record<string, string> = {}) {
  const nonce = randomToken(16);
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    // form-action also governs the redirect after POST, so the client's callback origin must be listed.
    `form-action ${["'self'", ...formAction].join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${STYLES}</style></head><body><main><div class="line" aria-hidden="true"></div><div class="body">${body}</div></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

export function renderLoginPage(view: LoginView, status = 200, headers: Record<string, string> = {}) {
  const body = `
<p class="brand">SOLSOL</p>
<h1>Přihlášení partnera</h1>
<p class="lead">Aplikace <strong>${esc(view.clientName)}</strong> žádá o přístup k vašim partnerským cenám a skladové dostupnosti (pouze čtení).</p>
${view.error ? `<p class="error" role="alert">${esc(view.error)}</p>` : ""}
<form method="post" action="/authorize" autocomplete="on">
<input type="hidden" name="tx" value="${esc(view.txId)}">
<input type="hidden" name="csrf" value="${esc(view.csrf)}">
<div class="field"><label for="email">E-mail</label>
<input id="email" name="email" type="email" required maxlength="254" autocomplete="username" value="${esc(view.email ?? "")}"${view.email ? "" : " autofocus"}></div>
<div class="field"><label for="password">Heslo</label>
<input id="password" name="password" type="password" required maxlength="512" autocomplete="current-password"${view.email ? " autofocus" : ""}></div>
<div class="notice" role="note"><p>Přihlašujete se ke svému partnerskému účtu SOLSOL. Heslo se odešle do SOLSOL a neukládá se.</p><p lang="en">You are signing in to your SOLSOL partner account. Your password is sent to SOLSOL and is not stored.</p></div>
<div class="actions">
<button class="primary" type="submit" name="action" value="login">Přihlásit se</button>
<button class="secondary" type="submit" name="action" value="deny" formnovalidate>Zrušit</button>
</div>
</form>
<p class="meta">Po přihlášení budete přesměrováni na ${esc(view.redirectOrigin)}</p>`;
  return page("Přihlášení partnera – SOLSOL", body, status, [view.redirectOrigin], headers);
}

export function renderErrorPage(status: number, message: string) {
  const body = `<p class="brand">SOLSOL</p><h1>Přihlášení nelze dokončit</h1><p class="error" role="alert">${esc(message)}</p>`;
  return page("Chyba přihlášení – SOLSOL", body, status, []);
}
