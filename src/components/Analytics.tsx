import { useEffect, useState } from "react";
import { STAGE_LABEL, type Analytics as Data } from "../../shared/types";
import { api } from "../api";
import { sourceName } from "../format";
import { Bars, Columns } from "./Charts";

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export default function Analytics({ version }: { version: number }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.analytics().then(setD).catch((e: Error) => setErr(e.message));
  }, [version]);
  if (err) return <p className="err">{err}</p>;
  if (!d) return <p className="notice">Loading…</p>;

  const kpi = (label: string, value: string | number, sub?: string) => (
    <div className="kpi">
      <div className="kpi-v">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="kpi-l">{label}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );

  return (
    <>
      <section className="kpis">
        {kpi("Listings tracked", d.totals.listings, `${d.totals.active} for sale now`)}
        {kpi("Sellers contacted", d.totals.contacted)}
        {kpi("Replied", d.totals.replied, `${pct(d.totals.replied, d.totals.contacted)} of those contacted`)}
        {kpi("Deals in play", d.totals.inPlay, "conversation through due diligence")}
        {kpi("Average fit", d.totals.avgFit, "of listings for sale")}
      </section>

      <div className="grid">
        <section className="card">
          <h2>Pipeline by stage</h2>
          <Bars rows={d.byStage.map((s) => ({ label: STAGE_LABEL[s.stage], value: s.n }))} />
        </section>
        <section className="card">
          <h2>New listings per week</h2>
          <Columns points={d.newPerWeek.map((w) => ({ label: new Date(`${w.week}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: w.n }))} unit="listings" />
        </section>
        <section className="card">
          <h2>Time on the market</h2>
          <Bars rows={d.daysOnline.map((b) => ({ label: b.bucket, value: b.n }))} />
          <p className="hint">Listings for sale now. The longer a business has sat, the more room there usually is to negotiate.</p>
        </section>
        <section className="card">
          <h2>What the listings offer</h2>
          <Bars
            rows={[
              { label: "Seller financing", value: d.signals.sellerFinancing },
              { label: "Owner stays / trains", value: d.signals.ownerStays },
              { label: "Remote-manageable", value: d.signals.remote },
              { label: "Price cut, last 30 d", value: d.signals.priceDrops },
            ]}
          />
        </section>
      </div>

      <div className="grid">
        <section className="card">
          <h2>By marketplace</h2>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th className="r">Listings</th>
                <th className="r">Contacted</th>
                <th className="r">Replied</th>
                <th className="r">Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {d.bySource.map((s) => (
                <tr key={s.source}>
                  <td>{sourceName(s.source)}</td>
                  <td className="r num">{s.n}</td>
                  <td className="r num">{s.contacted}</td>
                  <td className="r num">{s.replied}</td>
                  <td className="r num">{pct(s.replied, s.contacted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>By industry</h2>
          <table>
            <thead>
              <tr>
                <th>Industry</th>
                <th className="r">Listings</th>
                <th className="r" title="Median asking price ÷ cash flow">
                  Median multiple
                </th>
                <th className="r">Average fit</th>
              </tr>
            </thead>
            <tbody>
              {d.byIndustry.map((s) => (
                <tr key={s.industry}>
                  <td>{s.industry}</td>
                  <td className="r num">{s.n}</td>
                  <td className="r num">{s.medianMultiple != null ? `${s.medianMultiple.toFixed(1)}x` : "—"}</td>
                  <td className="r num">{s.avgFit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid">
        <section className="card">
          <h2>Outreach</h2>
          <section className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
            {kpi("Sent", d.outreach.sent)}
            {kpi("Replies", d.outreach.replied)}
            {kpi("Waiting", d.outreach.pending)}
            {kpi("Need attention", d.outreach.failed)}
          </section>
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th className="r">Sent</th>
                <th className="r">Got the reply</th>
                <th className="r">Rate</th>
              </tr>
            </thead>
            <tbody>
              {d.outreach.byStep.map((s) => (
                <tr key={s.step}>
                  <td>{s.step === 0 ? "First message" : `Follow-up ${s.step}`}</td>
                  <td className="r num">{s.sent}</td>
                  <td className="r num">{s.replied}</td>
                  <td className="r num">{pct(s.replied, s.sent)}</td>
                </tr>
              ))}
              {d.outreach.byStep.length === 0 && (
                <tr>
                  <td className="muted" colSpan={4}>
                    Nothing sent yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>What the replies say</h2>
          <Bars rows={d.outreach.byClass.map((c) => ({ label: c.classification.replace(/_/g, " "), value: c.n }))} empty="No replies yet" />
        </section>
      </div>
    </>
  );
}
