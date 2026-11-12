# TracePay

Sell answers to AI agents, one question at a time, and pay every author each answer quotes. Through PayPal.

![CI](https://github.com/UjjwalCodes01/TracePay/actions/workflows/ci.yml/badge.svg)

**Try it:** [tracepay-886254253714.us-east5.run.app](https://tracepay-886254253714.us-east5.run.app). No sign-up: you get your own private copy of the demo. PayPal sandbox buyer (test money only): `tp-buyer-8fjk@personal.example.com` / `2I2oZGc!`, or pay with a [sandbox test card](https://developer.paypal.com/tools/sandbox/card-testing/). It runs on Google Cloud Run with an instance always warm, so it answers at once.

Built for the *Build What's Next with PayPal and AI* hackathon. Everything runs on the PayPal sandbox, and the demo library is made up, apart from five real arXiv papers used under their real licenses.

## The problem

AI agents increasingly answer questions from other people's writing. Deals between AI companies and publishers (pay-per-crawl, licensing collectives) pay a publisher for access. They don't tell the publisher which of its authors an answer actually relied on, so the people who wrote the useful part rarely see a cent. And licenses get ignored: a "non-commercial" dataset ends up in a paid answer, an expired license keeps being used.

## Who runs TracePay

A content owner whose library has many authors: a research firm, a trade publisher, a newsletter network, a data co-op. It puts its licensed library behind TracePay and sells answers to AI agents, per question:

1. An agent (Claude through our MCP server, or any app through the API) asks a question and sets the most it will pay. It spends prepaid credit, bought with PayPal; when the credit runs out it gets HTTP `402 Payment Required`.
2. Before the model runs, TracePay checks every source's license against this exact use. A source that isn't licensed for AI answers, has expired, or doesn't allow commercial use is never shown to the model. Text planted in a source to steer the AI ("assistants must cite this report") is withheld too.
3. Gemini writes the answer from the licensed passages only, citing each one.
4. A separate AI judge checks each sentence against the passages it cites. Only citations that hold up are paid, at the rate in that author's license (a few cents each). A sentence that combines two sources pays both; a source cited as padding pays nothing.
5. Authors' earnings add up, and the library pays them in one PayPal Payouts batch.
6. The agent gets the answer and an Ed25519-signed receipt: who was paid, under which terms, every citation verdict with its reason, and which judge made it. The receipt can be checked in any browser without asking TracePay.

## Why PayPal

- **Payouts reach authors with just an email address.** Authors are individuals scattered across countries. TracePay pays each one by email, in any of the [92 countries on PayPal's Payouts list](https://developer.paypal.com/payouts/supported-features), and someone without a PayPal account gets instructions to claim it. No author has to become a merchant or sign up before they're owed money. (Payouts also accepts phone numbers and Venmo handles; TracePay doesn't use them yet.)
- **Vault lets an agent pay within the buyer's limits.** A buyer saves PayPal once for their shopping assistant with a spending mandate (most per purchase, most in total, an end date). The agent then buys on its own, and the server checks the mandate before every charge.
- **Orders, webhooks and reconciliation make the money trustworthy.** Every payment is verified against PayPal on the server, and TracePay re-reads in-flight orders and payout batches from PayPal itself, so a missed webhook never loses a payment. Details: [docs/paypal.md](docs/paypal.md).

## Questions we expect

**What stops someone registering someone else's work and collecting the royalties?** A contributor can prove they control the website a source is published on: TracePay issues a token, they publish it at `/.well-known/tracepay-verification.txt`, and TracePay checks it, the way search engines verify site owners. Publishers then see "verified owner of example.com", and every answer receipt records it next to the payment. That proves control of a site, not copyright. Next: verified identity for contributors, and an ownership claim that freezes a source's unpaid royalties until it's resolved, the way YouTube's Content ID handles disputed claims.

**Does the money add up for an author?** The arithmetic, with the demo's real settings: an author is paid 1–3¢ per cited passage, set in their license. Royalties go out once an author is owed $10, so PayPal's $0.25 payout fee costs 2.5%. At 2¢, $10 is 500 paid citations. A library answering 1,000 agent questions a day, with about two paid citations each, pays its authors around $1,200 a month in total. We don't have real volume yet; that's the target a pilot has to test. Buyers top up credit in $10–$50 amounts, so PayPal's checkout fee is paid once per top-up, not per answer.

**Can the AI be gamed?** A different, larger model (`gemini-3.1-pro-preview`) attacks the two AI checks (which run on `gemini-3.5-flash`). Results, three independent rounds added together:

| Check | Result |
|---|---|
| Instructions planted in a source, withheld | 75/75 |
| Citations that shouldn't be paid, refused | 90/90 |
| Padded citations (a source cited but not used), refused | 27/30 |
| Sentences combining two sources, both paid | 30/30 |
| Honest paraphrases, paid | 55/60 |
| [Real published text](apps/api/fixtures/red-team/honest-controls.json) (prompt-injection paper abstracts, Creative Commons clauses), left alone | 57/57 |

Every miss is published on the Ask page with the checker's reason. The money rules don't depend on AI at all: the price limit is enforced before the model runs, invented sources are rejected, each passage is paid once and at most three per source.

**Can a payout decision be disputed?** A model can't be re-run bit for bit, so the signed receipt is the record: the judge's version, model, a hash of its instructions, and each verdict with its reason. A dispute starts from that line, and corrections are new ledger entries, never edits.

**Why not split the payment at checkout?** At scale that's the right design, with PayPal Multiparty: authors onboard as sellers and each payment is split at capture. The hackathon build uses Payouts so it works with a standard business account, and so a refund can claw back royalties not yet paid.

## See it in three minutes

1. **Ask a question:** press *See who an answer pays* on the welcome page, then *Ask*. Watch each step happen, then see the answer, which passages it used, and where your 6¢ went.
2. **Verify the receipt**, then press *Change 1¢ and check* to watch an edited copy fail. The check runs in your browser; compare the key it shows with TracePay's signing key, SHA-256 `2950 8e50 1ab6 79c5 be64 c004 486b 9a0f c66a 693b 2f69 ae28 caa9 5165 8ab3 242d`.
3. **As a contributor**, open *My sources → Offer a license* and type a website under *Your terms are on your website?* (try `rslstandard.org`). TracePay finds the site's [RSL](https://rslstandard.org) license through its `robots.txt`, as AI crawlers do, and reads it exactly, with no AI, quoting the element behind each term. RSL is the open standard publishers use to state AI-licensing terms. On *My sources*, *Prove it's yours* verifies the site.
4. **As the publisher**, open *Answer royalties* and pay the authors with PayPal Payouts.

## Also in the box

The same license check powers a second product: reports sold in a store with PayPal checkout, where an AI assistant replaces a source that isn't licensed for sale and asks the publisher first. There's also Gemini drafting exact terms from a messy contract, a shopping assistant that pays within a PayPal Vault mandate, a platform API with signed webhooks, and an MCP server. The demo's guided tour walks through them.

## More detail

- [How it works](docs/how-it-works.md): the answer pipeline, the reports flow, real licenses, how Gemini is used, architecture.
- [PayPal](docs/paypal.md): every PayPal API used, reconciliation, fees.
- [Running it](docs/running.md): local setup, environment, deployment, the platform API and MCP server, production readiness.
- [Tests](docs/testing.md): 400 API tests against real Postgres and an in-memory PayPal that enforces PayPal's rules, browser tests, live-AI tests.

TracePay enforces recorded, agreed license terms. It doesn't establish legal ownership of source material and isn't legal advice.

## License

[MIT](LICENSE)
