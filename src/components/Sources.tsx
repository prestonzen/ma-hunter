import { useEffect, useRef, useState } from "react";
import type { SavedSearch } from "../../shared/types";
import { api, type Status } from "../api";
import { bookmarklet } from "../clipper";
import { ago } from "../format";

const KINDS: { id: string; label: string; help: string; placeholder: string }[] = [
  { id: "browser", label: "Browser search (runner)", help: "Any marketplace's search-results URL, opened by the browser runner in your signed-in Chrome: BizBuySell, BizQuest, Flippa, LoopNet, BusinessBroker.net, Acquire.", placeholder: "https://www.bizbuysell.com/…/businesses-for-sale/?q=…" },
  { id: "empireflippers", label: "Empire Flippers (API)", help: "Fetched by the hub directly. Filters are optional JSON, e.g. {\"listing_price_to\": 1500000}.", placeholder: '{"listing_price_to": 1500000}' },
  { id: "flippa", label: "Flippa (API token)", help: "Uses the FLIPPA_TOKEN secret. Filters are optional JSON, e.g. {\"filter[property_type]\": \"website\"}. Without a token, add Flippa as a browser search instead.", placeholder: '{"filter[property_type]": "website"}' },
  { id: "url", label: "Web page (server fetch)", help: "A listings page on a site that allows server requests: Quiet Light, Website Closers, FE International, BusinessesForSale.com.", placeholder: "https://quietlight.com/listings/" },
];

export default function Sources({ status, onChanged }: { status: Status | null; onChanged: () => void }) {
  const [searches, setSearches] = useState<SavedSearch[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ source: "browser", name: "", query: "", everyHours: 12 });
  const [running, setRunning] = useState<number | null>(null);
  const link = useRef<HTMLAnchorElement>(null);

  const load = () => api.searches().then(setSearches).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  useEffect(() => {
    void load();
  }, []);
  // React refuses javascript: URLs in JSX, rightly; a bookmarklet is the one place we want one, so set it by hand.
  useEffect(() => {
    link.current?.setAttribute("href", bookmarklet(window.location.origin));
  }, []);

  const kind = KINDS.find((k) => k.id === f.source)!;
  const act = (p: Promise<unknown>, done: string) =>
    p
      .then(() => {
        setMsg({ ok: true, text: done });
        onChanged();
        return load();
      })
      .catch((e: Error) => {
        setMsg({ ok: false, text: e.message });
        return load();
      });

  const runnerOn = (status?.runners ?? []).some((r) => Date.now() - r.at < 10 * 60_000);

  return (
    <div className="stack">
      <section className="card">
        <h2>Saved searches</h2>
        <p className="hint">
          Each search runs on its own schedule and feeds the same list, so every marketplace ends up in one place. New listings are scored against your buy box as they arrive.
        </p>
        {msg && <p className={msg.ok ? "ok small" : "err small"}>{msg.text}</p>}
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Search</th>
                <th>Runs</th>
                <th>Last run</th>
                <th className="r">Seen</th>
                <th className="r">New</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(searches ?? []).map((s) => (
                <tr key={s.id} className={s.enabled ? "" : "dim"}>
                  <td style={{ maxWidth: 420 }}>
                    <b>{s.name}</b>
                    <div className="small muted" style={{ wordBreak: "break-all" }}>
                      {KINDS.find((k) => k.id === s.source)?.label ?? s.source}
                      {s.query ? ` · ${s.query}` : ""}
                    </div>
                    {s.lastError && <div className="err small">{s.lastError}</div>}
                  </td>
                  <td className="nowrap small">
                    every {s.everyHours} h{!s.enabled && " (off)"}
                    {s.source === "browser" && !runnerOn && s.enabled ? <div className="err">runner offline</div> : null}
                  </td>
                  <td className="nowrap small">{s.lastRun ? ago(s.lastRun) : <span className="muted">never</span>}</td>
                  <td className="r num">{s.lastCount ?? "—"}</td>
                  <td className="r num">{s.lastNew ?? "—"}</td>
                  <td className="r nowrap">
                    {s.source !== "browser" && (
                      <button
                        className="ghost mini"
                        disabled={running === s.id}
                        onClick={() => {
                          setRunning(s.id);
                          api
                            .runSearch(s.id)
                            .then((r) => setMsg({ ok: true, text: `${s.name}: ${r.count} listings seen, ${r.created} new` }))
                            .catch((e: Error) => setMsg({ ok: false, text: e.message }))
                            .finally(() => {
                              setRunning(null);
                              onChanged();
                              void load();
                            });
                        }}
                      >
                        {running === s.id ? "Running…" : "Run now"}
                      </button>
                    )}{" "}
                    <button className="ghost mini" onClick={() => void act(api.saveSearch({ ...s, enabled: s.enabled ? 0 : 1 }), s.enabled ? "Search switched off" : "Search switched on")}>
                      {s.enabled ? "Switch off" : "Switch on"}
                    </button>{" "}
                    <button className="danger mini" onClick={() => window.confirm(`Delete the search "${s.name}"? Listings it found stay.`) && void act(api.deleteSearch(s.id), "Search deleted")}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {searches && searches.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ padding: 20 }}>
                    No saved searches yet. Add one below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h3>Add a search</h3>
        <div className="form-grid">
          <label className="field">
            Source
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value, query: "" })}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. BizBuySell: landscaping in NC" />
          </label>
          <label className="field">
            Check every (hours)
            <input type="number" min={1} max={168} value={f.everyHours} onChange={(e) => setF({ ...f, everyHours: Number(e.target.value) })} />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            {f.source === "browser" || f.source === "url" ? "Search-results URL" : "Filters (optional JSON)"}
            <input value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} placeholder={kind.placeholder} />
          </label>
        </div>
        <p className="hint">{kind.help}</p>
        <button disabled={!f.name.trim()} onClick={() => void act(api.saveSearch(f), "Search added").then(() => setF({ ...f, name: "", query: "" }))}>
          Add search
        </button>
      </section>

      <div className="grid">
        <section className="card">
          <h2>Browser clipper</h2>
          <p>
            For any page you're looking at yourself. Drag this to your bookmarks bar:{" "}
            <a ref={link} className="bookmarklet" onClick={(e) => e.preventDefault()} title="Drag me to the bookmarks bar">
              Clip to M&amp;A Hunter
            </a>
          </p>
          <ol className="steps small">
            <li>Open a listing, or a page of search results, on any marketplace.</li>
            <li>Click the bookmark. A hub tab opens with what it read.</li>
            <li>Check it and press Save. On a search page, tick the listings to keep.</li>
          </ol>
          <p className="hint">It runs in your browser with your sign-in, so it works on sites that block servers. Nothing is saved until you press Save.</p>
        </section>

        <section className="card">
          <h2>Saved-search alert emails</h2>
          <p className="small">
            Set up email alerts for your searches on each marketplace. The Gmail bridge forwards them here and the listings in them are added automatically, tagged <span className="tag">from-alert</span>.
          </p>
          <p className="small muted">Recognised senders: {(status?.alertDomains ?? []).join(", ")}.</p>
          <p className="hint">
            Gmail bridge: {status?.gmailBridge ? `last checked in ${ago(status.gmailBridge.at)}` : "not connected yet"}. Setup is on the <a href="#connect">Connect</a> tab.
          </p>
        </section>
      </div>
    </div>
  );
}
