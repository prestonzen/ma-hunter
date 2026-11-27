import { useEffect, useMemo, useState } from "react";
import { STAGE_LABEL, type QuantReport, type QuantView, type Valuation } from "../../shared/types";
import { underwrite, type Underwriting } from "../../shared/underwrite";
import { api, type ListingValuation } from "../api";
import { ago, date, money, sourceName } from "../format";
import { Meter } from "./Charts";

const signed = (x: number, digits = 0) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(digits)}%`;
const times = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(2)}x`);
const multipleOf = (i: { askingPrice: number | null; earnings: number | null }) => (i.askingPrice && i.earnings && i.earnings > 0 ? i.askingPrice / i.earnings : null);

/** Asking price against the model. Below the band is a prompt to ask why, so it is marked, not praised. */
export function GapPill({ v }: { v: Valuation }) {
  const text = `${signed(v.gap)} vs model`;
  if (v.band === "below") return <span className="pill accent" title="Asked below what comparable listings ask. A bargain, or something the listing doesn't say: ask.">{text}</span>;
  if (v.band === "above") return <span className="pill warn" title="Asked above what comparable listings ask.">{text}</span>;
  return <span className="pill" title="Inside the range comparable listings ask.">{text}</span>;
}

const isPicked = (i: { stage: string; starred: number }) => !!i.starred || (i.stage !== "new" && i.stage !== "passed");

const coverTone = (x: number | null) => (x == null ? "" : x >= 1.5 ? "good" : x >= 1.25 ? "warn" : "bad");

type SortKey = "gap" | "dscr" | "stress" | "cushion" | "like" | "ask";
type Show = "all" | "below" | "covers";

export default function Quant({ version, onOpen, onChanged }: { version: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const [d, setD] = useState<QuantView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [u, setU] = useState<Underwriting | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "gap", dir: 1 });
  const [show, setShow] = useState<Show>("all");

  const load = () =>
    api
      .quant()
      .then((x) => {
        setD(x);
        setU((cur) => cur ?? x.underwriting);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [version]);

  const refit = () => {
    setBusy(true);
    api
      .refitQuant()
      .then(() => load())
      .then(onChanged)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const rows = useMemo(() => {
    if (!d || !u) return [];
    // Shown as a rank among the listings not yet picked: raw similarity scores bunch near zero.
    const open = d.items.filter((i) => i.like != null && !isPicked(i)).map((i) => i.like!).sort((x, y) => x - y);
    const rank = (x: number) => (open.length > 1 ? open.filter((y) => y < x).length / (open.length - 1) : 1);
    const all = d.items.map((i) => ({ i, m: multipleOf(i), uw: underwrite(i, u), likeShare: i.like == null || !open.length ? null : Math.min(1, rank(i.like)) }));
    const kept = all.filter((r) => (show === "below" ? r.i.valuation?.band === "below" : show === "covers" ? (r.uw?.stressedDscr ?? 0) >= 1.25 : true));
    const val = (r: (typeof all)[number]): number | null =>
      sort.key === "gap" ? (r.i.valuation?.gap ?? null) : sort.key === "dscr" ? (r.uw?.dscr ?? null) : sort.key === "stress" ? (r.uw?.stressedDscr ?? null) : sort.key === "cushion" ? (r.uw?.cushion ?? null) : sort.key === "like" ? r.i.like : r.i.askingPrice;
    return kept.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last, either direction
      return (x - y) * sort.dir;
    });
  }, [d, u, sort, show]);

  if (err && !d) return <p className="err">{err}</p>;
  if (!d || !u) return <p className="notice">Loading…</p>;

  const r = d.report;
  const chosen = r?.models.find((m) => m.name === r.chosen);
  const base = r?.models[0];
  const below = d.items.filter((i) => i.valuation?.band === "below").length;
  const th = (key: SortKey, label: string, title: string, firstDir: 1 | -1 = -1) => (
    <th className="sort" title={title} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: firstDir }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );
  const field = (key: keyof Underwriting, label: string, step: number, hint?: string) => (
    <label className="field" title={hint}>
      {label}
      <input type="number" min={0} step={step} value={u[key] as number} onChange={(e) => setU({ ...u, [key]: Number(e.target.value) || 0 })} onBlur={() => void api.saveUnderwriting(u).catch((x: Error) => setErr(x.message))} />
    </label>
  );

  return (
    <div className="stack">
      {err && <p className="err">{err}</p>}
      <section className="card">
        <div className="card-head">
          <h2>What should it ask?</h2>
          <div className="row">
            {r && <span className="small muted">Fitted {ago(r.fitAt)} on {r.n} listings{d.stale ? "; listings have changed since" : ""}</span>}
            <button className={d.stale || !r ? "" : "ghost"} onClick={refit} disabled={busy}>
              {busy ? "Fitting…" : r ? "Refit" : "Fit the model"}
            </button>
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Each listing's asking multiple (price ÷ cash flow) is estimated from every <em>other</em> listing: size, margin, age, owner hours, business model and industry. The gap between that and what it actually asks is a reason
          to look closer. It is fitted on asking prices, not sale prices, and it is a screen, not an appraisal.
        </p>
      </section>

      {!r ? (
        <p className="notice">No fit yet. It needs at least 60 listings that state both an asking price and a cash flow figure.</p>
      ) : (
        <>
          <section className="kpis">
            <div className="kpi">
              <div className="kpi-v">{chosen?.label}</div>
              <div className="kpi-l">Model in use</div>
              <div className="small muted">the simplest one that tested best</div>
            </div>
            <div className="kpi">
              <div className="kpi-v">{chosen ? `${(chosen.mdape * 100).toFixed(0)}%` : "—"}</div>
              <div className="kpi-l">Typical miss on price</div>
              <div className="small muted">{base && chosen && chosen.name !== base.name ? `${(base.mdape * 100).toFixed(0)}% using the median multiple` : "out of sample"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-v">{r.tested}</div>
              <div className="kpi-l">Out-of-sample tests</div>
              <div className="small muted">newer listings priced from older ones</div>
            </div>
            <div className="kpi">
              <div className="kpi-v">{below}</div>
              <div className="kpi-l">Asked below the range</div>
              <div className="small muted">of {d.items.filter((i) => i.valuation).length} priced</div>
            </div>
          </section>

          <div className="grid">
            <ModelTable r={r} />
            <Drivers r={r} />
          </div>
        </>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Every listing, against the model and against the debt</h2>
          <select value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Which listings to show">
            <option value="all">All listings</option>
            <option value="below">Asked below the range</option>
            <option value="covers">Covers the debt in the bad year</option>
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                {th("ask", "Asking", "Asking price")}
                <th title="Asking price ÷ annual cash flow">Asks</th>
                <th title="The multiple the model expects, with the range 80% of comparable listings fall in">Model says</th>
                {th("gap", "Gap", "Asking price against the model's estimate", 1)}
                {th("dscr", "Coverage", "Debt service coverage on your assumptions: cash flow after an operator's pay, over loan payments")}
                {th("stress", "Bad year", `Coverage if cash flow falls ${u.stressPct}%`)}
                {th("cushion", "Cushion", "How far cash flow can fall before it no longer covers the loan and the operator")}
                {th("like", "Like your picks", "Text similarity to the listings you starred or moved forward, less similarity to the ones you passed on")}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map(({ i, m, uw, likeShare }) => (
                <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
                  <td className="title">
                    {i.starred ? "★ " : ""}
                    {i.title}
                    <div className="small muted">
                      {sourceName(i.source)}
                      {i.model ? ` · ${i.model}` : ""}
                      {i.stage !== "new" ? ` · ${STAGE_LABEL[i.stage]}` : ""}
                    </div>
                  </td>
                  <td>{money(i.askingPrice)}</td>
                  <td>{times(m)}</td>
                  <td>
                    {i.valuation ? (
                      <>
                        {times(i.valuation.fair)}
                        <div className="small muted">
                          {i.valuation.low.toFixed(1)}–{i.valuation.high.toFixed(1)}x
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{i.valuation ? <GapPill v={i.valuation} /> : "—"}</td>
                  <td>{uw?.dscr == null ? "—" : <span className={`pill ${coverTone(uw.dscr)}`}>{times(uw.dscr)}</span>}</td>
                  <td>{uw?.stressedDscr == null ? "—" : <span className={`pill ${coverTone(uw.stressedDscr)}`}>{times(uw.stressedDscr)}</span>}</td>
                  <td title={uw && !uw.hoursKnown ? "Owner hours not stated, so no operator pay was taken off" : undefined}>
                    {uw ? `${Math.round(uw.cushion * 100)}%` : "—"}
                    {uw && !uw.hoursKnown ? " *" : ""}
                  </td>
                  <td style={{ minWidth: 110 }}>{likeShare == null ? <span className="muted small">pick some first</span> : isPicked(i) ? <span className="muted small">one of your picks</span> : <Meter value={likeShare} max={1} title={`Closer to your picks than ${Math.round(likeShare * 100)}% of the other listings (similarity ${i.like?.toFixed(2)})`} />}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={9} className="muted">
                    Nothing matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          {d.picked ? `"Like your picks" learns from the ${d.picked} listing${d.picked === 1 ? "" : "s"} you starred or moved past New.` : 'Star a few listings or move them to Shortlist and "Like your picks" ranks the rest by resemblance.'} * owner hours
          not stated.
        </p>
      </section>

      <section className="card">
        <h2>Your underwriting assumptions</h2>
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {field("downPct", "Cash down %", 1)}
          {field("ratePct", "Loan rate %", 0.25)}
          {field("termYears", "Loan term (years)", 1)}
          {field("closingPct", "Closing costs %", 0.5, "Fees, closing costs and working capital, paid in cash")}
          {field("managerSalary", "Operator pay (full time)", 5000, "What it costs a year to pay someone for 40 hours a week of the owner's work")}
          {field("stressPct", "Bad year: cash flow falls %", 5)}
          <label className="row" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input
              type="checkbox"
              checked={u.replaceOwner}
              onChange={(e) => {
                const next = { ...u, replaceOwner: e.target.checked };
                setU(next);
                void api.saveUnderwriting(next).catch((x: Error) => setErr(x.message));
              }}
            />
            Pay someone to do the owner's hours
          </label>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Coverage is cash flow, less operator pay for the hours the owner works, over a year of loan payments. These are your numbers and a screen: a lender, an accountant and the seller's real books decide what a deal carries.
        </p>
      </section>

      {r && (
        <section className="card">
          <h2>Read this before trusting it</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>
              Listings from {date(r.from)} to {date(r.to)}. A model is used only if it beats a simpler one by 2% or more when tested on listings newer than the ones it was fitted on.
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

function ModelTable({ r }: { r: QuantReport }) {
  const edge = r.vsBaseline;
  return (
    <section className="card">
      <h2>How the models did, out of sample</h2>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th title="Median miss on price, on listings the model had not seen">Typical miss</th>
            <th title="Mean absolute error in log multiple">Error</th>
            <th title="Share of the median baseline's error removed">Vs median</th>
          </tr>
        </thead>
        <tbody>
          {r.models.map((m) => (
            <tr key={m.name} title={`Error in each test block, oldest first: ${m.blocks.map((b) => b.toFixed(3)).join(", ")}`}>
              <td>
                {m.label} {m.name === r.chosen && <span className="pill accent">in use</span>}
              </td>
              <td>{(m.mdape * 100).toFixed(1)}%</td>
              <td>{m.mae.toFixed(3)}</td>
              <td>{m.name === r.models[0].name ? "baseline" : signed(-m.skill, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginBottom: 0 }}>
        Walk-forward: each model is fitted on older listings and tested on newer ones, four times over, {r.tested} tests in all. "Vs median" is the change in error against guessing the median multiple (negative is better).
        {r.chosen !== r.models[0].name &&
          ` The model in use cuts the error by ${edge.diff.toFixed(3)} (95% interval ${edge.lo.toFixed(3)} to ${edge.hi.toFixed(3)} by bootstrap${edge.lo > 0 ? ", so the edge is not noise" : ", which includes zero"}).`}
      </p>
    </section>
  );
}

function Drivers({ r }: { r: QuantReport }) {
  const share = new Map(r.importance.map((f) => [f.name, f.share]));
  return (
    <section className="card">
      <h2>What moves the multiple</h2>
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th title="Change in the asking multiple for a typical step up in this feature (one standard deviation), other things equal: the linear model's read">Effect</th>
            <th title="Share of the boosted trees' error reduction that came from this feature: a second opinion that doesn't assume straight lines">Trees lean on it</th>
          </tr>
        </thead>
        <tbody>
          {r.drivers.slice(0, 9).map((f) => (
            <tr key={f.name}>
              <td>{f.name}</td>
              <td>{signed(f.effect, 1)}</td>
              <td>{share.has(f.name) ? `${Math.round(share.get(f.name)! * 100)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginBottom: 0 }}>Associations in what sellers ask, not causes. Days on the market is left out on purpose: a listing lingers because it is overpriced.</p>
    </section>
  );
}

/** On a listing's page: its estimate, what pushes it, the bad year, and the listings most like it. */
export function ValuationPanel({ listingId, askingPrice, earnings, ownerHours }: { listingId: number; askingPrice: number | null; earnings: number | null; ownerHours: number | null }) {
  const [d, setD] = useState<ListingValuation | null>(null);
  useEffect(() => {
    setD(null);
    api.valuation(listingId).then(setD).catch(() => setD(null));
  }, [listingId, askingPrice, earnings]);
  if (!d) return null;
  const v = d.valuation;
  const m = multipleOf({ askingPrice, earnings });
  const uw = underwrite({ askingPrice, earnings, ownerHours }, d.underwriting);
  const tab = window.location.hash.replace("#", "").split("/")[0] || "listings";
  return (
    <section className="card">
      <h2>Against comparable listings</h2>
      {v && m ? (
        <>
          <div className="facts">
            <div className="fact">
              <div className="k">Asks</div>
              <div className="v">{times(m)}</div>
            </div>
            <div className="fact">
              <div className="k">Model says</div>
              <div className="v">
                {times(v.fair)}{" "}
                <span className="small muted">
                  ({v.low.toFixed(1)}–{v.high.toFixed(1)}x)
                </span>
              </div>
            </div>
            <div className="fact">
              <div className="k">Gap</div>
              <div className="v">
                <GapPill v={v} />
              </div>
            </div>
            {uw?.stressedDscr != null && (
              <div className="fact">
                <div className="k">Coverage in a bad year</div>
                <div className="v">
                  <span className={`pill ${coverTone(uw.stressedDscr)}`}>{times(uw.stressedDscr)}</span> <span className="small muted">cash flow −{d.underwriting.stressPct}%</span>
                </div>
              </div>
            )}
            {uw && (
              <div className="fact">
                <div className="k">Cushion</div>
                <div className="v">{Math.round(uw.cushion * 100)}%</div>
              </div>
            )}
          </div>
          <p className="small" style={{ margin: "10px 0 0" }}>
            {v.band === "below"
              ? "Asked below what similar listings ask. Either a bargain or something the listing leaves out: ask why it is priced this way."
              : v.band === "above"
                ? "Asked above what similar listings ask. Ask what justifies the premium, or expect room to negotiate."
                : "Priced in line with similar listings."}
            {v.drivers.length > 0 && ` What moves its estimate most: ${v.drivers.map((x) => `${x.name.toLowerCase()} (${signed(x.effect)})`).join(", ")}.`}
          </p>
        </>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {d.fitAt ? "No estimate for this one: it needs an asking price and a cash flow figure, then a refit on the Valuation tab." : "No model fitted yet. See the Valuation tab."}
        </p>
      )}
      {d.comps.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Most like it</h3>
          <table>
            <tbody>
              {d.comps.map((c) => (
                <tr key={c.id}>
                  <td className="title">
                    <a href={`#${tab}/${c.id}`}>{c.title}</a>
                    <div className="small muted">
                      {sourceName(c.source)}
                      {c.model ? ` · ${c.model}` : ""}
                    </div>
                  </td>
                  <td>{money(c.askingPrice)}</td>
                  <td>{times(multipleOf(c))}</td>
                  <td>{c.valuation ? <GapPill v={c.valuation} /> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="hint" style={{ marginBottom: 0 }}>A screen built from asking prices, not an appraisal. Bad-year coverage uses the assumptions on the Valuation tab.</p>
    </section>
  );
}
