import { useEffect, useState } from "react";
import { STAGE_LABEL, type PublicSummary } from "../shared/types";
import { api } from "./api";
import Admin from "./components/Admin";
import { Bars } from "./components/Charts";
import Clip from "./components/Clip";
import { sourceName } from "./format";

const REPO = "https://github.com/prestonzen/ma-hunter";

export default function App() {
  const path = window.location.pathname;
  const isAdmin = path.startsWith("/admin");
  const isClip = path.startsWith("/clip");
  return (
    <div className={`shell${isAdmin ? "" : " narrow"}`}>
      <header className="top">
        <a className="brand" href={isAdmin || isClip ? "/admin" : "/"}>
          <img src="/favicon.svg" alt="" />
          M&amp;A Hunter
        </a>
        <nav>
          {!isAdmin && <a href="/admin">Admin</a>}
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>
      {isAdmin ? <Admin /> : isClip ? <Clip /> : <Public />}
    </div>
  );
}

/** The public page shows counts only, and only when PUBLIC_DASHBOARD is on. Deal details never leave the admin. */
function Public() {
  const [data, setData] = useState<PublicSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.summary().then(setData).catch((e: Error) => setErr(e.message));
  }, []);

  return (
    <main>
      <section className="hero">
        <h1>Every business for sale, in one pipeline.</h1>
        <p>
          M&amp;A Hunter pulls listings from BizBuySell, Flippa, Empire Flippers and other marketplaces into one scored list, tracks each deal from first
          look to close, and runs the outreach to brokers and owners with follow-ups.
        </p>
        <p className="row">
          <a className="btn" href="/admin">
            Open the admin
          </a>
          <a className="btn ghost" href={REPO} target="_blank" rel="noreferrer">
            Read the code
          </a>
        </p>
      </section>
      {err && <p className="err">Couldn't load the summary: {err}</p>}
      {data?.enabled && data.totals && (
        <>
          {data.demo && <p className="pill accent">Demo data</p>}
          <section className="kpis">
            <Kpi label="Listings tracked" value={data.totals.tracked} />
            <Kpi label="Sellers contacted" value={data.totals.contacted} />
            <Kpi label="Conversations" value={data.totals.conversations} />
            <Kpi label="Marketplaces" value={data.totals.sources} />
          </section>
          <div className="grid">
            <section className="card">
              <h2>Pipeline</h2>
              <Bars rows={(data.byStage ?? []).map((s) => ({ label: STAGE_LABEL[s.stage], value: s.n }))} />
            </section>
            <section className="card">
              <h2>Listings by marketplace</h2>
              <Bars rows={(data.bySource ?? []).map((s) => ({ label: sourceName(s.source), value: s.n }))} />
            </section>
          </div>
        </>
      )}
      <footer className="foot">The public page shows counts only: no business names, prices, contacts or notes ever leave the admin.</footer>
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="kpi">
      <div className="kpi-v">{value.toLocaleString()}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}
