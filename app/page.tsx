import { EndpointField } from '@/components/endpoint-field'

const tools = [
  {
    name: 'search_products',
    description:
      'Full-text search across the catalogue — names, model codes, brands, and catalogue numbers.',
    args: 'query, limit',
  },
  {
    name: 'get_product',
    description:
      'Full product detail: description, technical parameters, images, and downloadable documents.',
    args: 'identifier',
  },
  {
    name: 'list_categories',
    description: 'The full category tree. Slugs can be passed to browse_category.',
    args: '—',
  },
  {
    name: 'browse_category',
    description: 'Paginated product listing for a single category.',
    args: 'category, limit, after',
  },
  {
    name: 'get_price',
    description:
      'Partner only. Your customer-specific price incl. and excl. VAT, currency, and quantity tiers.',
    args: 'catalogNumber',
  },
  {
    name: 'check_availability',
    description: 'Partner only. Availability status and stock quantities per warehouse.',
    args: 'catalogNumber',
  },
]

export default function Home() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-12 px-6 py-16 md:py-24">
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />
            MCP server &middot; Streamable HTTP
          </span>
        </div>
        <h1 className="text-balance font-mono text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          SOLSOL catalogue MCP server
        </h1>
        <p className="text-pretty leading-relaxed text-muted-foreground">
          Read-only access to the public{' '}
          <a
            href="https://solsol.eu"
            className="underline underline-offset-4 hover:text-foreground"
            target="_blank"
            rel="noreferrer"
          >
            solsol.eu
          </a>{' '}
          photovoltaic catalogue for AI assistants and agents. Sign in with a SOLSOL partner account
          to add your customer-specific prices and stock. Read-only; ordering is not supported.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Endpoint</h2>
        <EndpointField path="/mcp" />
        <p className="text-sm leading-relaxed text-muted-foreground">
          Point any MCP-compatible client at this URL. Anonymous access returns public catalogue
          data. Clients that support OAuth can sign in with your SOLSOL partner account; your
          password is sent to SOLSOL and is not stored.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Tools</h2>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {tools.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-1.5 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <code className="font-mono text-sm font-medium text-foreground">{tool.name}</code>
                <span className="font-mono text-xs text-muted-foreground">{tool.args}</span>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{tool.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Connect a client</h2>
        <dl className="flex flex-col gap-3 text-sm leading-relaxed">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Claude (web / desktop)</dt>
            <dd className="text-muted-foreground">
              Settings &rarr; Connectors &rarr; Add custom connector &rarr; paste the endpoint URL above.
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Claude Code</dt>
            <dd className="font-mono text-xs text-muted-foreground">
              claude mcp add --transport http solsol &lt;endpoint URL&gt;
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">MCP Inspector</dt>
            <dd className="font-mono text-xs text-muted-foreground">
              npx @modelcontextprotocol/inspector &rarr; Streamable HTTP &rarr; endpoint URL
            </dd>
          </div>
        </dl>
      </section>

      <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
        OAuth 2.1 with PKCE. Sign out at any time by disconnecting the connector in your client.
      </footer>
    </main>
  )
}
