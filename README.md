# M&A Hunter

**One dashboard for every business for sale.** M&A Hunter pulls listings from BizBuySell, Flippa, Empire Flippers and other marketplaces into one scored list, tracks each deal from first look to close, and runs the outreach to brokers and owners, with follow-ups, from your own Gmail.

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
| BizBuySell, BizQuest, Flippa search, LoopNet, BusinessBroker.net, Acquire | **Browser runner**: your saved search pages opened in a real Chrome you signed in to | Verified end to end against a fake marketplace (`runner/selftest.mjs`); not yet run against the live sites |
| Any page you're looking at | **Browser clipper** bookmarklet: preview, then save | Verified locally |
| Saved-search alert emails | The Gmail bridge forwards them; listings are added automatically | Parser unit-tested on sample alerts; check it against your first real alert |
| AI agents | MCP at `/mcp`, REST at `/api/agent/*` | Verified locally |

BizBuySell, BizQuest, Flippa's site and LoopNet answer servers with 403. The hub does not try to get around that: those sites are read in your own browser, by the runner or the clipper.

## Setup

### 1. Run it locally with demo data

```bash
npm install
npm run demo        # builds, then serves http://127.0.0.1:8788 in demo mode
```

Open `/admin` (no sign-in on localhost in demo mode) and press **Load demo data**: 16 fictional businesses, brokers and conversations.

### 2. Deploy

The hub runs at **https://ma-hunter.kaizencloud.workers.dev** (Kaizen Apps account; D1 `ma-hunter`, R2 `ma-hunter-files`). `npm run deploy` ships a new version. To stand up your own copy from scratch:

```bash
npx wrangler login
npx wrangler d1 create ma-hunter                 # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create ma-hunter-files
npx wrangler secret put ADMIN_TOKEN              # 24+ random characters; you sign in with it on /admin
npx wrangler secret put GMAIL_BRIDGE_TOKEN       # 24+ random characters, shared with the Gmail bridge
npx wrangler secret put AGENT_TOKENS             # {"zenith":"<24+ random characters>"} for the runner and agents
npx wrangler secret put FLIPPA_TOKEN             # optional
npm run deploy
```

The database schema is applied on the first request; there is no migrate step.

### 3. Tell it what you're looking for

**Buy box** tab: price range, minimum cash flow, highest multiple, target and excluded industries, locations, and your synergy keywords. Saving re-scores everything.
**Outreach → Sender & limits**: your name, company, phone, reply-to email, and a sentence or two about you as a buyer.

### 4. Connect Gmail

Paste [integrations/gmail-bridge.gs](integrations/gmail-bridge.gs) into a new project at script.google.com, set the script properties `HUB_URL` and `BRIDGE_TOKEN`, and run `install` once. It runs inside your Google account every 5 minutes: no OAuth app, and no password leaves Google. It forwards only mail in threads the hub started, from contacts you've written to, or from marketplace alert addresses.

### 5. Start the browser runner

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
npm test                           # parser, scoring, outreach logic
node runner/selftest.mjs           # runner end to end, against the local hub
```

| Path | What |
|---|---|
| `worker/src/parse.ts` | Listing pages, alert emails and replies → fields. Label-driven, no DOM |
| `worker/src/score.ts` | Fit score and synergy |
| `worker/src/listings.ts` | Upsert (bulk, lock-aware), filters, edits |
| `worker/src/outreach.ts` | Templates, sequences, the queue, reply handling |
| `worker/src/sources.ts` | Importers, saved searches, runner and alert intake |
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
- Weekly D1 backup to R2.
