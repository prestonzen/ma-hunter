import { useEffect, useState } from "react";
import type { BuyBox } from "../../shared/types";
import { api } from "../api";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The buy box: what you're looking for. Every listing's fit score and synergy come from this. */
export default function BuyBoxForm({ onChanged }: { onChanged: () => void }) {
  const [b, setB] = useState<BuyBox | null>(null);
  // Comma-separated fields are edited as plain text and split on save, so typing a comma doesn't fight the cursor.
  const [lists, setLists] = useState({ industriesInclude: "", industriesExclude: "", keywordsExclude: "", locations: "", synergyKeywords: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setB(r.buybox);
        setLists({
          industriesInclude: r.buybox.industriesInclude.join(", "),
          industriesExclude: r.buybox.industriesExclude.join(", "),
          keywordsExclude: r.buybox.keywordsExclude.join(", "),
          locations: r.buybox.locations.join(", "),
          synergyKeywords: r.buybox.synergyKeywords.join(", "),
        });
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  if (!b) return <p className="notice">{msg?.text ?? "Loading…"}</p>;

  const money = (k: "priceMin" | "priceMax" | "cashFlowMin", label: string) => (
    <label className="field">
      {label}
      <input inputMode="numeric" value={b[k] ?? ""} placeholder="any" onChange={(e) => setB({ ...b, [k]: e.target.value.trim() === "" ? null : Number(e.target.value.replace(/[$,\s]/g, "")) || null })} />
    </label>
  );
  const csv = (k: keyof typeof lists, label: string, hint: string, placeholder: string) => (
    <label className="field">
      <span>
        {label} <span className="hint">{hint}</span>
      </span>
      <input value={lists[k]} placeholder={placeholder} onChange={(e) => setLists({ ...lists, [k]: e.target.value })} />
    </label>
  );

  const save = () => {
    setBusy(true);
    const next: BuyBox = { ...b, industriesInclude: list(lists.industriesInclude), industriesExclude: list(lists.industriesExclude), keywordsExclude: list(lists.keywordsExclude), locations: list(lists.locations), synergyKeywords: list(lists.synergyKeywords) };
    api
      .saveBuyBox(next)
      .then((r) => {
        setB(r.buybox);
        setMsg({ ok: true, text: `Saved. Re-scored ${r.rescored} listing${r.rescored === 1 ? "" : "s"}.` });
        onChanged();
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Size</h2>
        <div className="form-grid">
          {money("priceMin", "Asking price from")}
          {money("priceMax", "Asking price up to")}
          {money("cashFlowMin", "Cash flow (SDE) at least")}
          <label className="field">
            <span>
              Highest multiple <span className="hint">(price ÷ cash flow)</span>
            </span>
            <input inputMode="decimal" value={b.multipleMax ?? ""} placeholder="4" onChange={(e) => setB({ ...b, multipleMax: e.target.value.trim() === "" ? null : Number(e.target.value) || null })} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>What and where</h2>
        <div className="stack">
          {csv("industriesInclude", "Target industries", "comma-separated; matched against the industry, business model and title", "Landscaping, Pest control, SaaS")}
          {csv("industriesExclude", "Never show me", "an excluded industry scores 0", "Restaurant, Vape")}
          {csv("keywordsExclude", "Excluded words", "anywhere in the listing", "franchise, MLM")}
          {csv("locations", "Locations", "state codes or names; leave empty for anywhere", "NC, SC, TN")}
          <div className="row">
            <label className="check" title="Businesses outside your locations only count if they can be run remotely">
              <input type="checkbox" checked={b.requireRemote} onChange={(e) => setB({ ...b, requireRemote: e.target.checked })} /> Must be manageable remotely (unless it's in my area)
            </label>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Deal terms</h2>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={b.preferSellerFinancing} onChange={(e) => setB({ ...b, preferSellerFinancing: e.target.checked })} /> I want seller financing on the table
          </label>
          <label className="check">
            <input type="checkbox" checked={b.preferOwnerStays} onChange={(e) => setB({ ...b, preferOwnerStays: e.target.checked })} /> I want the owner to stay on, not just train and leave
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Synergy</h2>
        <div className="stack">
          <label className="field">
            <span>
              What you already own or do well <span className="hint">goes into broker introductions as your background</span>
            </span>
            <textarea rows={3} value={b.synergyProfile} onChange={(e) => setB({ ...b, synergyProfile: e.target.value })} placeholder="I own a landscaping company in the Southeast and a small software studio." />
          </label>
          {csv("synergyKeywords", "Synergy keywords", "a listing that mentions these gets a synergy score of 3 to 5; word stems work", "landscap, lawn, irrigation, outdoor")}
        </div>
      </section>

      <div className="row">
        <button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save and re-score everything"}
        </button>
        {msg && <span className={msg.ok ? "ok" : "err"}>{msg.text}</span>}
      </div>
      <p className="hint">
        How the score adds up to 100: price 20, cash flow 15, multiple 15, industry 10, location or remote 10, financing 10, synergy 10, owner transition 5, seller motivation 5. A listing that doesn't state
        something gets half credit for it, so missing information sinks to the middle, not the bottom.
      </p>
    </div>
  );
}
