# SOLSOL katalog – MCP server (demo)

Read-only MCP server nad **katalogem solsol.eu**. Dva endpointy:

| Endpoint | Přihlášení | Obsah |
|---|---|---|
| `/mcp` | **Povinné** (OAuth 2.1, partnerský účet) | Veřejný katalog + vaše ceny a sklad |
| `/mcp-public` | Žádné | Jen veřejný katalog (bez cen a skladu) |

Data čte z GraphQL API, které používá samotný eshop (`https://solsol.eu/graphql/`), takže jsou vždy aktuální.

## Nástroje

| Nástroj | Endpoint | Popis |
|---|---|---|
| `search_products` | oba | Fulltext (název, model, značka, katalogové číslo). Na `/mcp` přihlášeně navíc vaše cena a sklad |
| `get_product` | oba | Detail: popis, technické parametry, obrázky, dokumenty (datasheet, manuály). Vstup: kat. číslo / slug / URL. Na `/mcp` přihlášeně navíc vaše cena a sklad |
| `list_categories` | oba | Strom kategorií |
| `browse_category` | oba | Produkty kategorie se stránkováním (`after` = `nextCursor`) |
| `get_price` | jen `/mcp` | Vaše cena s DPH / bez DPH, DPH, měna, množstevní ceny. Vstup: katalogové číslo |
| `check_availability` | jen `/mcp` | Stav dostupnosti a množství skladem (celkem i po skladech). Vstup: katalogové číslo |

`/mcp-public` nikdy nevyžádá cenu, sklad ani dostupnost (hlídá to test) a ignoruje i případný Bearer token.
`/mcp` bez platného tokenu vždy vrátí `401` s `WWW-Authenticate` odkazujícím na `/.well-known/oauth-protected-resource` – žádný nástroj tam není dostupný anonymně.

## Nasazení na Vercel (2 minuty)

**A) CLI**
```bash
npm i
npx vercel        # první nasazení (preview)
npx vercel --prod # produkční URL
```

**B) GitHub** – nahrát složku do repozitáře → vercel.com → *Add New Project* → Import. Pro přihlášení partnerů nastavte proměnné prostředí (viz níže).

Výsledné endpointy: `https://<projekt>.vercel.app/mcp` (přihlášení partnera) a
`https://<projekt>.vercel.app/mcp-public` (bez přihlášení).

> Pozor: pokud je u projektu zapnutá *Deployment Protection* (Vercel Authentication), Claude se k endpointu nepřipojí. Pro demo ji vypněte.
> Hobby plán je jen pro nekomerční použití – pro firemní nasazení použijte Pro.
> Pro `/mcp` je nutné nastavit `MCP_TOKEN_ENCRYPTION_KEY` a Redis (viz „Přihlášení partnera“ níže) – bez nich endpoint OAuth metadata nenačte a přihlášení nebude fungovat.

## Připojení klienta

- **Claude (web/desktop)**: Settings → Connectors → *Add custom connector* → URL `https://<projekt>.vercel.app/mcp` → Claude vás automaticky přihlásí (viz níže). Pro anonymní přístup použijte `/mcp-public`.
- **Claude Code**: `claude mcp add --transport http solsol https://<projekt>.vercel.app/mcp`
- **Test**: `npx @modelcontextprotocol/inspector` → Streamable HTTP → URL výše.

## Lokálně

```bash
npm i
npm run dev      # http://localhost:3000/mcp (přihlášení) a /mcp-public (bez přihlášení)
npm test         # 41 testů (klient eshopu, MCP protokol, OAuth vrstva – eshop vždy mockovaný)
npm run typecheck
```

Volitelné proměnné: `SOLSOL_GRAPHQL_URL`, `SOLSOL_SITE_URL` (např. pro testovací prostředí).

## Architektura

- `lib/solsol.ts` – jediné místo, které zná eshop (GraphQL dotazy + mapování). Výměna za jiný zdroj / přihlášený přístup se dělá tady.
- `lib/tools.ts` – definice MCP nástrojů.
- `app/mcp/route.ts` – přihlašovaný endpoint (`mcp-handler`, `withMcpAuth({ required: true })` – bez platného tokenu vrátí `401` dřív, než se zavolá jakýkoli nástroj).
- `app/mcp-public/route.ts` – anonymní endpoint, jen veřejné nástroje, žádné `withMcpAuth`.
- `lib/eshop.ts` – přihlášený klient eshopu (login, `X-Auth-Token`, 401 → refresh → opakování); `lib/partner.ts` – ceny a sklad.
- `lib/oauth/*` – OAuth 2.1 server (`/authorize`, `/token`, `/register`, `/logout`, metadata), šifrované uložení tokenů v Redis.
- Odpovědi eshopu se na Vercelu cachují 5 minut.

## Přihlášení partnera (OAuth) – ceny a dostupnost

`/mcp` je zároveň vlastním **OAuth 2.1 autorizačním serverem**, který přemosťuje přihlášení do eshopu
(eshop sám OAuth nepodporuje, jen e-mail + heslo), a je na něm **vyžadováno přihlášení** – bez platného
tokenu vrátí `401` dřív, než je vidět jakýkoli nástroj. Pro anonymní přístup k veřejnému katalogu bez
přihlášení použijte `/mcp-public`. Po přihlášení na `/mcp` navíc:

| Nástroj | Popis |
|---|---|
| `get_price` | Vaše cena s DPH / bez DPH, DPH, měna, množstevní ceny. Vstup: katalogové číslo |
| `check_availability` | Stav dostupnosti a množství skladem (celkem i po skladech). Vstup: katalogové číslo |
| `search_products`, `get_product` | Navíc obsahují vaši cenu a dostupnost |

Pouze čtení – objednávat nelze.

### Jak přihlášení funguje

1. Klient (Claude) zavolá `/mcp` (i bez jakéhokoli úmyslu se přihlásit), vždy dostane `401` s odkazem na
   `/.well-known/oauth-protected-resource` a `/.well-known/oauth-authorization-server`, zaregistruje se
   (`/register`, Dynamic Client Registration, nebo Client ID Metadata Document) a otevře `/authorize`
   s PKCE (S256 povinně).
2. `/authorize` zobrazí přihlašovací formulář **na doméně tohoto serveru**. Heslo se jednou pošle do eshopu
   (`LoginMutation`) a **nikde se neukládá**.
3. Uloží se jen tokeny eshopu – šifrované AES-256-GCM (`MCP_TOKEN_ENCRYPTION_KEY`) v Upstash Redis s TTL.
   Klient dostane náhodný neprůhledný MCP token (platnost 1 h) + rotující refresh token (30 dní).
4. Když eshop vrátí `401`, server tokeny eshopu obnoví (`RefreshTokens`) a požadavek zopakuje. Pokud
   obnovení selže, `/mcp` vrátí `401 invalid_token` a klient spustí přihlášení znovu.
5. `POST /logout` (Bearer token nebo `token=` ve formuláři) zneplatní MCP token a smaže uložené tokeny eshopu.

Zabezpečení: rate limit přihlášení 5 pokusů / 15 min na IP i na e-mail, CSRF token + kontrola `Origin`
a `state`, přísná CSP bez skriptů, jednorázový autorizační kód (60 s) vázaný na `client_id`, `redirect_uri`
a PKCE, přesná shoda `redirect_uri` (jen `https://` nebo `http://localhost`), opakované použití kódu
nebo starého refresh tokenu zruší celou relaci. Chybová hláška při přihlášení je vždy stejná
(neprozrazuje, zda e-mail existuje). Hesla, tokeny ani odpovědi GraphQL se nelogují.

### Proměnné prostředí

| Proměnná | Povinná | Popis |
|---|---|---|
| `MCP_TOKEN_ENCRYPTION_KEY` | ano | 32bajtový klíč (base64 nebo 64 hex znaků): `openssl rand -base64 32` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | ano | Upstash Redis – doplní se samy po přidání integrace *Upstash for Redis* z Vercel Marketplace |
| `MCP_PUBLIC_URL` | ne | Veřejná adresa serveru (issuer), např. `https://solsol-mcp.vercel.app`. Výchozí = adresa požadavku |
| `SOLSOL_LOCALE` | ne | Jazyk GraphQL endpointu eshopu, výchozí `cs` (`/cs/graphql/<Operace>`) |
| `SOLSOL_SITE_URL`, `SOLSOL_GRAPHQL_URL` | ne | Jiné prostředí eshopu (např. testovací) |

Vzor je v `.env.example`. Tajné hodnoty patří jen do Vercel → Settings → Environment Variables.
Klíč `MCP_TOKEN_ENCRYPTION_KEY` neměňte za provozu – všechny uložené relace by přestaly fungovat
(uživatelé se prostě přihlásí znovu).

### Připojení z Claude

- **Claude (web / desktop)**: Settings → Connectors → *Add custom connector* → URL
  `https://<projekt>.vercel.app/mcp` → *Connect*. Otevře se přihlašovací stránka SOLSOL, zadáte
  partnerský e-mail a heslo, Claude se vrátí přihlášený. Pole *OAuth Client ID/Secret* nechte prázdná
  (klient se registruje sám).
- **Claude Code**: `claude mcp add --transport http solsol https://<projekt>.vercel.app/mcp`, pak v Claude
  Code příkaz `/mcp` → *solsol* → *Authenticate*.
- **Odhlášení**: v Claude konektor odpojte; úplné zneplatnění na serveru = `POST /logout` s tokenem.
- **Bez přihlášení**: konektor funguje i nepřihlášený – jen s veřejnými nástroji.

### Testy

`npm test` – eshop je v testech vždy mockovaný (žádné skutečné přihlašovací údaje). Pokrývá mj. selhání PKCE,
opakované použití kódu, špatné `redirect_uri`, `401 → refresh → opakování`, selhání refresh → auth chyba,
anonymní režim a rate limit.

## Omezení

- GraphQL API eshopu je určené pro jeho vlastní frontend, ne jako oficiální partnerské API; schéma se může změnit.
- `/mcp` vyžaduje přihlášení partnerským účtem; pro veřejná data bez cen a skladu bez přihlášení použijte `/mcp-public`.
