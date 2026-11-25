# M&A Hunter browser runner

BizBuySell, BizQuest, Flippa and LoopNet refuse requests from servers, and most listings can only be answered through a contact form. The runner is a small Node program that drives a real Chrome on a machine of yours and does two jobs for the hub:

- **source**: opens each saved *browser search*, finds the listings the hub hasn't seen, opens each one and sends the page text to the hub, which parses and scores it.
- **contact**: opens a listing and types an inquiry you approved in the hub into its contact form.
- **sign** (optional): signs an NDA on your Documenso's signing page, for the NDAs your auto-sign rule in the hub clears.

What it deliberately does not do:

- **No passwords.** You sign in to each marketplace yourself, once, in the runner's Chrome. The session lives in the `profile/` folder on that machine. The hub never sees it.
- **No CAPTCHA solving and no block evasion.** If a site shows a bot check or a block page, the runner stops and marks the task "needs you" in the hub.
- **No rushing.** One page every 5 to 12 seconds, a capped number of listing pages per search run, and the hub's daily cap on contact forms.

## Setup

Needs Node 20+ and Google Chrome installed.

```bash
cd runner
npm install
cp config.example.json config.json
```

In `config.json` set `hubUrl` to your hub and `token` to this runner's token. The token is whatever you put under the runner's name in the Worker's `AGENT_TOKENS` secret, e.g. `{"zenith":"<24+ random chars>"}`.

Sign in to each marketplace you use (once):

```bash
node runner.mjs --login https://www.bizbuysell.com
node runner.mjs --login https://flippa.com
```

A Chrome window opens. Sign in, get past any "are you human" check, then close the window.

Run it:

```bash
node runner.mjs          # works until stopped
node runner.mjs --once   # one task, then exit
```

Then add browser searches in the hub (Sources → Add a search → Browser search): paste the URL of a search-results page with your filters applied.

## Contact forms

By default the runner fills a form in and **leaves it open for you to press send** (`"submitForms": false`); the message shows as "Needs you" in the hub until you press *I sent it by hand*. Set `"submitForms": true` to have the runner press send. Every message is one you approved in the hub first, and the hub caps forms per day (Outreach → Sender & limits).

The form filler is generic: it looks for a form with a message box, fills name, email, phone and message, and refuses to submit if a required field is left that it doesn't understand. When it can't finish, the hub shows why, with a button that copies the message and opens the listing.

### Handing contact forms to an AI agent instead

An agent with a browser handles unusual forms better than the generic filler. Give the runner `"capabilities": ["source"]` so it leaves contact tasks alone, connect the agent to the hub's MCP endpoint, and run it with the prompt in [agent-prompt.md](agent-prompt.md):

```bash
claude mcp add --transport http ma-hunter https://<your hub>/mcp --header "Authorization: Bearer <agent token>"
claude -p "$(cat agent-prompt.md)"
```

## Signing NDAs

Documenso has no API for signing: a signature is made on its signing page. With `"sign"` among the runner's `capabilities` and `documensoUrl` set to your Documenso (e.g. `https://esign.example.com`), the runner opens the signing link the hub gives it, types your name as the signature, puts it in the signature field, presses Complete and confirms. It only ever signs on that one site, and only NDAs the hub marked for it (NDAs tab, "Signing without asking"). The hub then asks Documenso itself whether the document is complete before it files anything.

If the page wants a sign-in, a passkey or a code, or a field is left over, the runner stops and leaves the page open for you.

To check it against your Documenso version, make a throwaway envelope and run:

```bash
node sign-check.mjs <signing url> "<name to sign as>" <page> <positionX> <positionY> <width> <height>
```

Verified against Documenso's v2 signing page on 2026-11-25.

## Where to run it

- **A desktop you use** (simplest): run it in a terminal; Chrome opens on your screen, and you can watch and step in.
- **An always-on box or container**: it needs a display for Chrome. Run under Xvfb with a VNC or noVNC view so you can sign in and clear the occasional check, e.g. `xvfb-run -a node runner.mjs` after doing the `--login` step over VNC. Mount `profile/` as a volume so sign-ins survive restarts. Use a residential connection: marketplaces treat datacenter addresses with suspicion.

## Self-test

With the hub running locally in demo mode (`npm run demo` in the repo root, with an agent token in `.dev.vars`):

```bash
node selftest.mjs
```

It serves a fake marketplace, runs sourcing over it, pushes one inquiry through the fake contact form, and checks the hub recorded everything.

## Settings

| Key | Default | What |
|---|---|---|
| `hubUrl`, `token` | | The hub and this runner's agent token (or `MAH_HUB_URL` / `MAH_TOKEN` env vars) |
| `profileDir` | `profile` | Chrome profile folder holding your sign-ins |
| `channel` | `chrome` | Installed browser to drive (`msedge` also works) |
| `headless` | `false` | Leave false: you need to see the window to sign in and to send forms by hand |
| `capabilities` | `["source","contact"]` | Which jobs this runner takes. Add `"sign"` to have it sign NDAs |
| `documensoUrl` | | Your Documenso's address; the only site the runner will sign on (or `MAH_DOCUMENSO_URL`) |
| `submitForms` | `false` | Press send on contact forms |
| `maxDetailPages` | `20` | Listing pages opened per search run |
| `pauseSeconds` | `[5, 12]` | Wait between pages, random in this range |
| `pollSeconds` | `90` | Wait before asking the hub again when idle |
