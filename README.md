# TracePay

**The license compiler and settlement engine for AI-generated products.**

TracePay checks whether a proposed AI-generated deliverable can legally be built from its selected licensed sources, records which sources actually contributed to the result, and — when the deliverable sells through PayPal — calculates and pays each contributor under their pre-approved license terms.

> 🚧 Under active development for the *Build What's Next with PayPal and AI* hackathon.

## How it works

1. **Preflight** — a deterministic license compiler checks every selected source against the intended use (commercial sale, derivative report, raw redistribution, territory, validity, economics) and blocks incompatible builds.
2. **Generate** — a bounded Publisher Agent (Vertex AI / Gemini) builds a report only from approved source versions; every citation is validated against recorded retrieval events.
3. **Sell** — the buyer pays with PayPal Checkout (Orders v2); the backend captures and verifies the payment.
4. **Settle** — contributor shares are calculated from frozen, approved terms in integer cents and paid out with the PayPal Payouts API.
5. **Audit** — a signed receipt links source versions → artifact → sale → settlement → payout status.

## License

[MIT](LICENSE)
