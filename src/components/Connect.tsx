import type { Status } from "../api";
import { ago } from "../format";

const REPO = "https://github.com/prestonzen/ma-hunter";

/** Setup for the three things that live outside the Worker: the Gmail bridge, the browser runner, and AI agents. */
export default function Connect({ status }: { status: Status | null }) {
  const origin = status?.origin ?? window.location.origin;
  const c = status?.configured;
  const flag = (ok: boolean | undefined, yes: string, no: string) => <span className={`pill ${ok ? "good" : "warn"}`}>{ok ? yes : no}</span>;

  return (
    <div className="stack">
      <section className="card">
        <h2>Secrets on the Worker</h2>
        <table>
          <tbody>
            <tr>
              <td>
                <code>GMAIL_BRIDGE_TOKEN</code>
              </td>
              <td>{flag(c?.bridgeToken, "Set", "Not set")}</td>
              <td className="small muted">Shared secret for the Gmail bridge script.</td>
            </tr>
            <tr>
              <td>
                <code>AGENT_TOKENS</code>
              </td>
              <td>{flag(!!c?.agents.length, `Set: ${c?.agents.join(", ")}`, "Not set")}</td>
              <td className="small muted">JSON map of name → token, for the browser runner and AI agents.</td>
            </tr>
            <tr>
              <td>
                <code>FLIPPA_TOKEN</code>
              </td>
              <td>{flag(c?.flippaToken, "Set", "Optional")}</td>
              <td className="small muted">Flippa API access token. Without it, add Flippa as a browser search.</td>
            </tr>
          </tbody>
        </table>
        <pre className="code">{`npx wrangler secret put GMAIL_BRIDGE_TOKEN\nnpx wrangler secret put AGENT_TOKENS      # {"zenith":"<24+ random chars>"}\nnpx wrangler secret put FLIPPA_TOKEN      # optional`}</pre>
        <p className="hint">You type the values into wrangler yourself; they are never stored in the repo or shown here.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>1. Gmail bridge: sending, follow-ups, replies, alerts</h2>
          {flag(!!status?.gmailBridge && Date.now() - status.gmailBridge.at < 20 * 60_000, `Connected${status?.gmailBridge?.account ? ` as ${status.gmailBridge.account}` : ""}`, status?.gmailBridge ? `Last seen ${ago(status.gmailBridge.at)}` : "Not connected")}
        </div>
        <p className="small">
          A Google Apps Script that runs inside your own Google account every 5 minutes. It sends approved emails from your Gmail (follow-ups go into the same thread), reports replies back so sequences stop, and forwards marketplace
          alert emails so new listings are added. No OAuth app, and no password leaves Google.
        </p>
        <ol className="steps small">
          <li>
            Open <a href="https://script.google.com" target="_blank" rel="noreferrer">script.google.com</a> → New project → paste{" "}
            <a href={`${REPO}/blob/main/integrations/gmail-bridge.gs`} target="_blank" rel="noreferrer">
              integrations/gmail-bridge.gs
            </a>
            .
          </li>
          <li>
            Project Settings → Script properties: <code>HUB_URL</code> = <code>{origin}</code>, <code>BRIDGE_TOKEN</code> = the value you gave <code>GMAIL_BRIDGE_TOKEN</code>.
          </li>
          <li>
            Run <code>install</code> once and approve the permissions (read and send Gmail, connect to the hub).
          </li>
        </ol>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>2. Browser runner: BizBuySell, Flippa and contact forms</h2>
          {status?.runners.length ? <span className="pill good">{status.runners.map((r) => `${r.name} (${ago(r.at)})`).join(", ")}</span> : <span className="pill warn">No runner yet</span>}
        </div>
        <p className="small">
          The big marketplaces refuse requests from servers, and most only offer a contact form. The runner is a small Node program that drives a real Chrome on a machine of yours (a desktop, or a container with a display). You sign in to
          each marketplace once in that Chrome; the runner then opens your saved browser searches, reads the listings into the hub, and types approved messages into listing contact forms. It never handles passwords and stops for a person
          when it meets a CAPTCHA.
        </p>
        <pre className="code">{`git clone ${REPO} && cd ma-hunter/runner\nnpm install\ncp config.example.json config.json    # set hubUrl to ${origin} and your agent token\nnode runner.mjs --login https://www.bizbuysell.com   # sign in by hand, once per site\nnode runner.mjs                        # then leave it running`}</pre>
        <p className="hint">
          Contact forms are filled in and left for you to press send unless <code>submitForms</code> is true in config.json. See runner/README.md for running it in a container, and for handing contact tasks to an AI agent instead.
        </p>
      </section>

      <section className="card">
        <h2>3. AI agents (MCP)</h2>
        <p className="small">
          Any agent that speaks MCP can source listings into the hub and work the contact-form queue with its own browser: <code>get_buy_box</code>, <code>search_listings</code>, <code>upsert_listings</code>, <code>add_note</code>,{" "}
          <code>next_contact_task</code>, <code>report_contact</code>. The token decides who the agent is.
        </p>
        <pre className="code">{`claude mcp add --transport http ma-hunter ${origin}/mcp --header "Authorization: Bearer <agent token>"`}</pre>
        <p className="small">The same operations over REST:</p>
        <pre className="code">{`curl -H "Authorization: Bearer <agent token>" ${origin}/api/agent/buybox\ncurl -X POST -H "Authorization: Bearer <agent token>" -H "Content-Type: application/json" \\\n  -d '{"listings":[{"url":"https://…","title":"…","askingPrice":450000,"rawText":"…page text…"}]}' \\\n  ${origin}/api/agent/listings`}</pre>
      </section>
    </div>
  );
}
