# TracePay MCP server

Lets an AI agent (Claude Desktop, an IDE agent, any MCP client) shop for licensed research
reports on TracePay **for a buyer** — through the Platform API, with the buyer's API key.

| Tool | What it does |
|---|---|
| `search_reports` | Reports for sale, best match first, with price and whether citations are verified |
| `check_report` | Re-runs the license compiler as of today; returns the full text once the buyer owns it |
| `start_checkout` | Creates a PayPal checkout and returns the **approve link for the buyer** |
| `complete_checkout` | After the buyer approved at PayPal: capture, verify, unlock |
| `checkout_status` | Where a checkout stands |

**The agent can never pay.** PayPal asks the buyer to approve every payment; the agent only
completes a checkout the buyer already approved. `start_checkout` also refuses anything over
`TRACEPAY_MAX_PRICE_CENTS`, reports the buyer already owns, and reports whose licenses no
longer permit a sale.

## Set up

1. Sign in to TracePay as a **buyer** → *Connect an AI agent* → create an API key.
2. In this repository: `npm install` (Node 24+, which runs the TypeScript directly).
3. Add to your MCP client's config (Claude Desktop: *Settings → Developer → Edit config*):

```json
{
  "mcpServers": {
    "tracepay": {
      "command": "node",
      "args": ["/path/to/TracePay/packages/mcp/src/server.ts"],
      "env": {
        "TRACEPAY_API_KEY": "tp_…",
        "TRACEPAY_MAX_PRICE_CENTS": "5000"
      }
    }
  }
}
```

`TRACEPAY_API_URL` defaults to the hosted demo (`https://trace-pay-umber.vercel.app/api/v1`);
point it at `http://localhost:4000/api/v1` for a local API.

Then ask: *"Find me a report on developer tools and AI coding assistants under $25."*
