# TracePay MCP server

Lets an AI agent (Claude Desktop, an IDE agent, any MCP client) shop for licensed research
reports on TracePay **for a buyer** — through the Platform API, with the buyer's API key.

| Tool | What it does |
|---|---|
| `search_reports` | Reports for sale, best match first, with price and whether citations are verified |
| `check_report` | Re-runs the license check as of today; returns the full text once the buyer owns it |
| `start_checkout` | Creates a PayPal checkout and returns the **approve link for the buyer** |
| `complete_checkout` | After the buyer approved at PayPal: capture, verify, unlock |
| `checkout_status` | Where a checkout stands |
| `ask_library` | **Pay-per-citation:** answers from sources licensed for AI only; the user's credit pays each contributor for the passages the answer verifiably used, never more than `TRACEPAY_MAX_ANSWER_CENTS` |
| `list_libraries` · `credit_balance` | Libraries that answer questions; the user's answer credit |
| `top_up_credits` · `complete_top_up` | Buy answer credit with PayPal: returns the approve link for the user |

**Spending is capped three ways:** per answer (`TRACEPAY_MAX_ANSWER_CENTS`), per session (`TRACEPAY_MAX_SESSION_CENTS`) and per purchase (`TRACEPAY_MAX_PRICE_CENTS`); an invalid value stops the server rather than disabling a cap. The agent only asks a library you name (`TRACEPAY_LIBRARY_ID` or `library_id`) unless exactly one exists. Every paying request carries a fresh `Idempotency-Key`, and text from sources is marked as data, not instructions.

**The agent pays only what the buyer allowed.** By default PayPal asks the buyer to approve every payment and the agent only hands over the approve link. If the buyer saves PayPal for their agent in the TracePay app (a *spending mandate*: most per purchase, most in total, an end date), `start_checkout` pays at once within it — TracePay checks the mandate on the server before every charge, and the agent's own `TRACEPAY_MAX_PRICE_CENTS` cap still applies. The buyer can revoke it at any time.

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
        "TRACEPAY_MAX_PRICE_CENTS": "5000",
        "TRACEPAY_MAX_ANSWER_CENTS": "50",
        "TRACEPAY_MAX_SESSION_CENTS": "200",
        "TRACEPAY_LIBRARY_ID": "user_atlas"
      }
    }
  }
}
```

`TRACEPAY_API_URL` defaults to the hosted demo (`https://trace-pay-umber.vercel.app/api/v1`);
point it at `http://localhost:4000/api/v1` for a local API.

Then ask: *"Find me a report on developer tools and AI coding assistants under $25."* — or *"Ask the TracePay library how fast AI coding assistant spend is growing."*
