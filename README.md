# M&A Hunter

**One dashboard for every business for sale.** M&A Hunter pulls listings from BizBuySell, Flippa, Empire Flippers and other marketplaces into one scored list, tracks each deal from first look to close, runs the outreach to brokers and owners, with follow-ups, from your own Gmail, gets the NDAs signed through your own Documenso, and prices every listing against all the others with a validated model.

It is the M&A counterpart of [job-agent-hub](https://github.com/prestonzen/job-agent-hub): same shape (a Cloudflare hub, a browser runner on your own machine, MCP for agents), different hunt.

```
Marketplaces ──┬─ Empire Flippers API ──────────── cron ─┐
               ├─ Flippa API (your token) ──────── cron ─┤
               ├─ pages that allow servers ─────── cron ─┤
               ├─ saved-search alert emails ── Gmail ────┤
               ├─ BizBuySell / BizQuest / Flippa         ├─▶  Worker  ──▶  D1  (listings, pipeline, outreach)
               │    search pages ── browser runner ──────┤       │    ──▶  R2  (documents, page snapshots)
               ├─ any page you're looking at ─ clipper ──┤       │
               └─ AI agents ── MCP / REST ───────────────┘       ▼
                                                          React admin: pipeline · listings · outreach
Outreach ──  approved email ──▶ Gmail bridge ──▶ your Gmail ──▶ broker      replies ──▶ back to the hub
             approved form message ──▶ browser runner ──▶ the listing's contact form
```

## What it tracks for every listing

| | |
|---|---|
| **Time online** | Days since it was listed (or since first seen, marked `+`), with the full asking-price history |
| **Seller financing** | Yes / no / not stated, with the sentence it came from; SBA eligibility |
| **Industry and model** | As the marketplace states them |
| **Contacted** | When, how often, by which channel, and whether they replied |
| **Reason for selling** | Read from the listing, and from the broker's reply when the listing is silent |
| **Synergy** | 0 to 5 from your synergy keywords, or set by hand |
| **Manageable remotely** | Yes / partly / no, plus the owner's role and hours per week |
| **Owner stays on** | Stays / transition and training only / leaves |
| **Also** | Asking price, revenue, cash flow, EBITDA, multiple, inventory, FF&E, real estate, employees, year established, broker, NDA and CIM status, notes, documents |

Nothing is guessed: a field the listing doesn't state stays "not stated", and the first outreach email asks for exactly those fields.

## What it does

- **Fit score, 0 to 100.** Each listing is scored against your buy box (price, cash flow, multiple, industry, location or remote, financing, synergy, owner transition, seller motivation) with a breakdown you can read. Excluded industries score 0. Unknowns get half credit, so sparse listings land mid-table, not at the bottom.
- **Pipeline board.** New → Shortlist → Contacted → In conversation → NDA signed → Reviewing financials → LOI → Due diligence → Closed / Passed. Drag to move.
- **Outreach with follow-ups.** Templates and sequences; the first message waits for your approval, follow-ups go out on schedule and stop the moment the contact replies. Daily caps, sending hours and a pause switch.
- **Two contact channels.** Email goes from your own Gmail (follow-ups in the same thread). Listings with only a contact form get the message typed into that form by the browser runner, or by an AI agent, or by you with one click to copy it.
- **Replies understood.** A reply is filed on its listing and read: still available, sold, wants an NDA, wants proof of funds, wants a call. What it says about financing, the reason for selling or the owner staying fills the listing's gaps.
- **NDAs, signed through Documenso.** When a broker asks for an NDA, the hub writes yours for that listing; when their reply carries one as a PDF, the hub reads it, flags the clauses worth a look (fees, non-competes, indemnities, long or open-ended terms) and finds where the buyer signs. Either way it becomes an envelope in your Documenso with a signing link. You sign with a click, or the browser runner signs the ones your rule clears. The signed copy is filed on the listing, the listing moves to "NDA signed", and the copy goes back to the broker in the same thread with a request for the CIM.
- **Valuation: what should it ask?** Every listing's asking multiple is estimated from all the other listings, out of sample, with a range. Listings asked below the range are marked for a closer look, each one shows the listings most like it, and the whole list is stress-tested against your financing assumptions. See [The quant layer](#the-quant-layer).
- **Broker introductions.** Send brokers your buy box so they think of you before a deal is listed.
- **Deal math.** Down payment, bank loan, seller note → debt service, coverage (DSCR) and cash-on-cash, per listing.
- **Duplicates and price cuts.** The same business on two marketplaces is flagged; an asking-price change is logged with its history.
- **Documents.** CIMs, NDAs and financials in a private R2 bucket; listing pages are snapshotted so the details survive after a listing is taken down.
- **Analytics.** Funnel, new listings per week, time on market, median multiple by industry, reply rates per marketplace and per follow-up.
- **CSV export**, and a counts-only public page that is off unless you switch it on.

## Where listings come from

Each marketplace gets the channel that works for it. All of them feed the same list.

| Source | How | Status |
|---|---|---|
| Empire Flippers | Public API, on a cron | Verified against the live API |
| Flippa | API with your own access token (`FLIPPA_TOKEN`) | Written to Flippa's v3 API; not yet run with a real token |
| Quiet Light, Website Closers, FE International, BusinessesForSale.com, and other sites that allow server requests | "Web page" saved search, or paste one listing URL | Generic parser (JSON-LD + labelled fields) |
| BizBuySell, BizQuest, Flippa search, LoopNet, BusinessBroker.net, Acquire, Boopos | **Browser runner**: your saved search pages opened in a real Chrome you signed in to | Verified end to end against a fake marketplace (`runner/selftest.mjs`); not yet run against the live sites. Boopos sits wholly behind its sign-in, so its listing-URL shape is a guess until the first signed-in run |
| Any page you're looking at | **Browser clipper** bookmarklet: preview, then save | Verified locally |
| Saved-search alert emails | The Gmail bridge forwards them; listings are added automatically | Parser unit-tested on sample alerts; check it against your first real alert |
| AI agents | MCP at `/mcp`, REST at `/api/agent/*` | Verified locally |

BizBuySell, BizQuest, Flippa's site and LoopNet answer servers with 403. The hub does not try to get around that: those sites are read in your own browser, by the runner or the clipper.

## The quant layer

Quant research applied to buying a small business: the question is not "will the price go up" but "what do listings like this one ask, and can its cash flow carry the debt". The code is [worker/src/quant.ts](worker/src/quant.ts) (pure TypeScript, no dependencies, about 650 lines) and [shared/underwrite.ts](shared/underwrite.ts).

### What it does

| Step | Method | Why |
|---|---|---|
| Target | Log of the asking multiple (price ÷ annual cash flow) | Errors read as percentages; a $50K and a $5M listing count the same |
| Features | Size, margin, age, owner hours, financing and transition flags, business model, industry, source | Days on the market is left out on purpose: a listing lingers *because* it is overpriced, so it is an effect of the target |
| Baselines | The median multiple; the median of the listing's business model (shrunk toward the overall median) | A model that can't beat these is not worth running |
| Comparables | k-nearest neighbours on standardised features | The spreadsheet "comps table", made testable |
| Linear | Ridge regression, penalty chosen by cross-validation inside the training rows | Readable coefficients |
| Non-linear | Gradient-boosted trees, written from scratch (depth 2, slow learning rate, fixed settings) | Checks whether interactions add anything the line misses |
| Model choice | Walk-forward: fit on older listings, test on newer ones, four blocks | No listing is ever priced by a model that saw the future |
| Leakage control | Cross-posted copies of one business never straddle a split; fill values, category lists and scaling are learned from the training rows only | The usual ways a valuation model flatters itself |
| Selection rule | A model replaces a simpler one only if it tests at least 2% better | Complexity has to pay for itself |
| Significance | Paired bootstrap of the test errors against the median baseline, 95% interval | "Better" should not be noise |
| Per-listing estimate | Out-of-fold (grouped 5-fold), with an 80% range from the out-of-fold residuals | A listing never prices itself |
| Sourcing | TF-IDF similarity: the listings most like this one, and "more like the ones I picked" by relevance feedback (Rocchio) | Learns the buy box from what you shortlist and pass on |
| Underwriting | Debt service coverage after paying an operator for the owner's hours, closing costs in the cash, a bad-year stress, and the cushion: how far cash flow can fall before it no longer covers the debt | The frictions and the downside, not the headline multiple |

### What it found

On the live hub's data on 2026-11-27: 170 Empire Flippers listings, 102 walk-forward tests.

| Model | Typical miss on price | Error (log multiple) | Vs median baseline |
|---|---|---|---|
| Median multiple | 19.0% | 0.205 | baseline |
| Median of its kind | 17.3% | 0.188 | −8.2% |
| Nearest comparables | 16.4% | 0.185 | −10.0% |
| **Ridge regression (in use)** | **14.7%** | **0.174** | **−15.1%** |
| Gradient-boosted trees | 14.2% | 0.171 | −16.7% |

Ridge cuts the baseline's error by 0.031 (bootstrap 95% interval 0.015 to 0.049, so the edge is real). The boosted trees tested 1.6% better than ridge, which is inside the 2% rule, so the simpler model is the one in use. Seventeen listings ask below their 80% range.

The edge is modest, and that is the honest result: on one marketplace that prices by formula, most of what there is to know about a multiple is the business model and the size.

### What it is not

- **It is fitted on asking prices, not sale prices.** It says what similar listings ask, not what they sell for. A sold-price dataset would change the meaning of every number here.
- **Survivorship.** The sample is what is listed today; the old listings in it are the ones that didn't sell.
- **One marketplace so far.** The fit reflects how Empire Flippers prices until BizBuySell, Flippa and Boopos listings are in.
- **A gap is a question, not an answer.** "Asked 40% below the model" means a bargain or something the listing leaves out.
- **Not built, on purpose:** a graph neural network for target matching (170 listings with no edges between them is not a graph problem; text similarity does the job and can be checked by eye) and a deal-break predictor (that is a public-markets merger-arbitrage tool; the small-business analogue, a survival model for time on market, needs listings to be watched until they sell and is on the roadmap).

## Setup

### 1. Run it locally with demo data

```bash
npm install
npm run demo        # builds, then serves http://127.0.0.1:8788 in demo mode
```

Open `/admin` (no sign-in on localhost in demo mode) and press **Load demo data**: 16 fictional businesses, brokers and conversations.

### 2. Deploy

The hub runs at **https://qla.prestonzen.com** (Kaizen Apps account; D1 `ma-hunter`, R2 `ma-hunter-files`). `npm run deploy` ships a new version. To stand up your own copy from scratch:

```bash
npx wrangler login
npx wrangler d1 create ma-hunter                 # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create ma-hunter-files
npx wrangler secret put ADMIN_TOKEN              # 24+ random characters; you sign in with it on /admin
npx wrangler secret put GMAIL_BRIDGE_TOKEN       # 24+ random characters, shared with the Gmail bridge
npx wrangler secret put AGENT_TOKENS             # {"zenith":"<24+ random characters>"} for the runner and agents
npx wrangler secret put FLIPPA_TOKEN             # optional
npx wrangler secret put DOCUMENSO_TOKEN          # optional: an API token from your Documenso, for NDA signing
npm run deploy
```

The database schema is applied on the first request; there is no migrate step.

### 3. Tell it what you're looking for

**Buy box** tab: price range, minimum cash flow, highest multiple, target and excluded industries, locations, and your synergy keywords. Saving re-scores everything.
**Outreach → Sender & limits**: your name, company, phone, reply-to email, and a sentence or two about you as a buyer.

### 4. Connect Gmail

Paste [integrations/gmail-bridge.gs](integrations/gmail-bridge.gs) into a new project at script.google.com, set the script properties `HUB_URL` and `BRIDGE_TOKEN`, and run `install` once. It runs inside your Google account every 5 minutes: no OAuth app, and no password leaves Google. It forwards only mail in threads the hub started, from contacts you've written to, or from marketplace alert addresses.

### 5. Connect Documenso (NDA signing)

Set `DOCUMENSO_URL` in `wrangler.jsonc` to your Documenso and store an API token from it (Settings, API tokens) as the `DOCUMENSO_TOKEN` secret. On the **NDAs** tab, set the name and title that sign, and how much may be signed without asking:

- **Never**: every NDA waits for your click.
- **My own NDA** (default): the runner signs the NDA the hub wrote from your template; a broker's NDA waits for you.
- **Mine, and clean ones of theirs**: also a broker's NDA when nothing is flagged red and the buyer's signature line was found.

Documenso has no API for signing, so a signature is always made on its signing page: by you (one click from the hub), or by the browser runner with the `sign` capability. The hub never tells Documenso to email anyone; it carries the signed copy back itself, through Gmail.

The clause scan is a set of patterns, not a lawyer. It tells you what to read; it does not tell you a document is safe.

### 6. Start the browser runner

On a machine with Chrome and a residential connection. See [runner/README.md](runner/README.md).

```bash
cd runner && npm install && cp config.example.json config.json   # set hubUrl and token
node runner.mjs --login https://www.bizbuysell.com                # sign in by hand, once per site
node runner.mjs
```

Then add your searches on the **Sources** tab, and set up email alerts for the same searches on each marketplace.

## Safety rails

- **Nothing is sent without approval** unless you switch a sequence to send without review. Follow-ups are auto-approved by default and stop on any reply.
- **Caps**: emails per day, contact forms per day, sending hours, weekdays only, and a pause switch. A contact marked do-not-contact is never written to again; "remove me" in a reply sets it.
- **The runner never handles passwords and never solves CAPTCHAs.** It stops and the task shows as "Needs you".
- **NDAs are never signed by the hub itself.** A broker's NDA with a red flag, or one whose signature line wasn't found, always waits for you, whatever the auto-sign rule says. The runner signs only on your own Documenso, and the hub asks Documenso whether a document is complete before it files or sends anything.
- **Hand edits are locked**: an import never overwrites a field you changed, and never replaces a known value with an unknown one.
- **Listing text is data.** Pages, emails and clipped content are parsed as text and rendered as text.

## Privacy model

- Secrets live only on the Worker. The browser bundle has none.
- `/api/admin/*` needs an HMAC-signed session cookie or the admin bearer token; rotating `ADMIN_TOKEN` signs everyone out.
- `/api/agent/*` and `/mcp` use per-agent bearer tokens; the Gmail bridge has its own.
- The public page shows counts only, and only when `PUBLIC_DASHBOARD` is `"true"`. No business name, price, contact or note is ever public.

## Development

```bash
npm run build && npm run dev:api   # Worker + local D1/R2 on http://127.0.0.1:8788 (demo mode)
npm run dev                        # Vite on http://localhost:5173, proxies /api and /mcp
npm run typecheck
npm test                           # parser, scoring, outreach logic, NDA reading, and the quant layer on synthetic data with a known answer
node runner/selftest.mjs           # runner end to end, against the local hub
node scripts/nda-selftest.mjs      # NDA signing end to end, against a stand-in Documenso (see the file's header)
```

| Path | What |
|---|---|
| `worker/src/parse.ts` | Listing pages, alert emails and replies → fields. Label-driven, no DOM |
| `worker/src/score.ts` | Fit score and synergy |
| `worker/src/listings.ts` | Upsert (bulk, lock-aware), filters, edits |
| `worker/src/outreach.ts` | Templates, sequences, the queue, reply handling |
| `worker/src/sources.ts` | Importers, saved searches, runner and alert intake |
| `worker/src/nda.ts` | NDAs: Documenso envelopes, the signing queue, filing and returning the signed copy |
| `worker/src/ndapdf.ts` | Our NDA as a PDF; reading a broker's NDA, the clause scan, finding the signature line |
| `worker/src/quant.ts` | The valuation models, their validation, text similarity. Pure functions |
| `worker/src/valuation.ts` | Fits on the listings in D1, stores the report and per-listing estimates, refits from the cron when listings change |
| `shared/underwrite.ts` | Debt service, coverage, the bad year, the cushion |
| `worker/src/mcp.ts` | MCP server for agents |
| `worker/src/db.ts` | Schema as ordered migrations, applied on first request |
| `src/` | React admin |
| `integrations/gmail-bridge.gs` | Gmail bridge (Apps Script) |
| `runner/` | Browser runner |

## Roadmap

- Validate the BizBuySell and Flippa page parsing against live pages and tune the labels.
- Enrich alert and search-card stubs automatically by having the runner visit them.
- LLM extraction (Workers AI) as a second pass over descriptions, and a draft reply for each broker response.
- A container image for the runner with a noVNC view.
- NDAs that arrive as a link to the broker's own e-signature page (DocuSign, a web form) instead of a PDF.
- A second signer on our own NDA, for sellers who want to countersign.
- Quant: a survival model for time on market (which listings go, and how fast) once enough have been watched to a sale; sold prices where a marketplace publishes them; the same clause-and-anomaly reading the NDA scan does, applied to CIMs and financials in the data room.
- Weekly D1 backup to R2.

## License

[MIT](LICENSE)
