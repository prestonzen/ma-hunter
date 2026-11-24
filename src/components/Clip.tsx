import { useEffect, useState } from "react";
import type { ListingInput } from "../../shared/types";
import { ApiError, api } from "../api";
import { TRI_LABEL, money } from "../format";

interface ClipPayload {
  type: "mah-clip";
  page: { url: string; title: string; text: string; jsonld?: unknown[]; meta?: Record<string, string>; emails?: string[]; phones?: string[] };
  cards: { url: string; title: string; text: string }[];
}

type Card = ListingInput & { isNew: boolean };

/**
 * Where the browser clipper lands. The marketplace page posts its text here; the hub parses it and shows
 * what it understood. Nothing is saved until Save is pressed. Whatever arrives is treated as text to
 * display, never as markup or instructions.
 */
export default function Clip() {
  const [payload, setPayload] = useState<ClipPayload | null>(null);
  const [mode, setMode] = useState<"page" | "cards">("page");
  const [listing, setListing] = useState<ListingInput | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as ClipPayload | undefined;
      if (!d || d.type !== "mah-clip" || typeof d.page?.url !== "string" || typeof d.page?.text !== "string") return;
      (e.source as Window | null)?.postMessage("mah-got", e.origin);
      setPayload((cur) => cur ?? d);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const parse = (p: ClipPayload) => {
    setErr(null);
    setNeedLogin(false);
    // A search page has many listing links; a listing page is about one business.
    const isSearch = p.cards.length >= 3;
    setMode(isSearch ? "cards" : "page");
    const fail = (e: Error) => {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
      else setErr(e.message);
    };
    api.previewPage(p.page).then((r) => setListing(r.listing)).catch(fail);
    if (p.cards.length) {
      api
        .previewCards(p.cards)
        .then((r) => {
          setCards(r.listings);
          setPicked(new Set(r.listings.filter((c) => c.isNew && c.url).map((c) => c.url!)));
        })
        .catch(fail);
    }
  };

  useEffect(() => {
    if (payload) parse(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const save = (listings: ListingInput[]) => {
    setBusy(true);
    api
      .upsert(listings)
      .then((r) => setSaved(`Saved: ${r.created} new, ${r.updated} updated${r.results.length === 1 ? "" : ` (${r.results.length} listings)`}.`))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  if (!payload) {
    return (
      <main>
        <section className="hero">
          <h1>Waiting for a page…</h1>
          <p>
            This tab receives pages from the M&amp;A Hunter clipper. Open a listing or a search-results page on a marketplace, then click the clipper in your bookmarks bar. Install it from{" "}
            <a href="/admin#sources">Sources</a>.
          </p>
        </section>
      </main>
    );
  }
  if (needLogin) {
    return (
      <main>
        <section className="hero">
          <h1>Sign in first</h1>
          <p>
            The page arrived, but you're not signed in to the hub. <a href="/admin" target="_blank" rel="noreferrer">Sign in in a new tab</a>, then come back here.
          </p>
          <button onClick={() => parse(payload)}>I've signed in: try again</button>
        </section>
      </main>
    );
  }
  if (saved) {
    return (
      <main>
        <section className="hero">
          <h1>{saved}</h1>
          <p className="row">
            <a className="btn" href="/admin#listings">
              Open the listings
            </a>
            <button className="ghost" onClick={() => window.close()}>
              Close this tab
            </button>
          </p>
        </section>
      </main>
    );
  }

  const set = (k: keyof ListingInput, v: unknown) => setListing((cur) => (cur ? { ...cur, [k]: v } : cur));
  const numField = (k: "askingPrice" | "cashFlow" | "revenue", label: string) => (
    <label className="field">
      {label}
      <input value={listing?.[k] ?? ""} inputMode="numeric" onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value.replace(/[$,\s]/g, "")) || null)} />
    </label>
  );

  return (
    <main style={{ marginTop: 16 }}>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <span className="muted small" style={{ wordBreak: "break-all" }}>
          Clipped from {payload.page.url}
        </span>
        {payload.cards.length > 0 && (
          <div className="seg">
            <button className={mode === "page" ? "on" : ""} onClick={() => setMode("page")}>
              This page as one listing
            </button>
            <button className={mode === "cards" ? "on" : ""} onClick={() => setMode("cards")}>
              {payload.cards.length} listings on this page
            </button>
          </div>
        )}
      </div>
      {err && <p className="err">{err}</p>}

      {mode === "page" &&
        (listing ? (
          <section className="card">
            <h2>Check what was read, then save</h2>
            <div className="form-grid">
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                Title
                <input value={listing.title} onChange={(e) => set("title", e.target.value)} />
              </label>
              {numField("askingPrice", "Asking price")}
              {numField("cashFlow", "Cash flow (SDE)")}
              {numField("revenue", "Revenue")}
              <label className="field">
                Industry
                <input value={listing.industry ?? ""} onChange={(e) => set("industry", e.target.value)} />
              </label>
              <label className="field">
                Location
                <input value={listing.location ?? ""} onChange={(e) => set("location", e.target.value)} />
              </label>
              <label className="field">
                Broker / contact
                <input value={listing.contactName ?? ""} onChange={(e) => set("contactName", e.target.value)} />
              </label>
              <label className="field">
                Contact email
                <input value={listing.contactEmail ?? ""} onChange={(e) => set("contactEmail", e.target.value)} />
              </label>
            </div>
            <table style={{ marginTop: 14 }}>
              <tbody>
                {(
                  [
                    ["Seller financing", TRI_LABEL[listing.sellerFinancing ?? "unknown"], listing.financingNotes],
                    ["Owner stays on", TRI_LABEL[listing.ownerStays ?? "unknown"], listing.transitionNotes],
                    ["Manageable remotely", TRI_LABEL[listing.remoteManageable ?? "unknown"], null],
                    ["Owner's role", TRI_LABEL[listing.ownerRole ?? "unknown"], listing.ownerHours ? `${listing.ownerHours} hours a week` : null],
                    ["Reason for selling", listing.reasonForSelling ?? "Not stated", null],
                    ["Established", listing.established ?? "—", null],
                    ["Employees", listing.employees ?? "—", null],
                  ] as [string, string | number, string | null | undefined][]
                ).map(([k, v, why]) => (
                  <tr key={k}>
                    <td className="muted nowrap">{k}</td>
                    <td>
                      <b>{v}</b>
                      {why ? <div className="small muted">{why}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">You can correct anything else after saving. The page's text is archived with the listing.</p>
            <button disabled={busy || !listing.title.trim()} onClick={() => save([{ ...listing, rawText: payload.page.text }])}>
              {busy ? "Saving…" : "Save listing"}
            </button>
          </section>
        ) : (
          <p className="notice">Reading the page…</p>
        ))}

      {mode === "cards" && (
        <section className="card">
          <div className="card-head">
            <h2>Listings found on this page</h2>
            <button disabled={busy || picked.size === 0} onClick={() => save(cards.filter((c) => c.url && picked.has(c.url)).map(({ isNew: _isNew, ...c }) => c))}>
              {busy ? "Saving…" : `Save ${picked.size} selected`}
            </button>
          </div>
          <p className="hint">New ones are ticked. A search page only shows the headline numbers; open a listing and clip it (or let the browser runner visit it) for the full details.</p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Business</th>
                <th className="r">Asking</th>
                <th className="r">Cash flow</th>
                <th>Location</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.url} className={c.isNew ? "" : "dim"}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Save ${c.title}`}
                      checked={!!c.url && picked.has(c.url)}
                      onChange={() =>
                        setPicked((cur) => {
                          const next = new Set(cur);
                          if (next.has(c.url!)) next.delete(c.url!);
                          else next.add(c.url!);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td>
                    <b>{c.title}</b>
                  </td>
                  <td className="r num">{money(c.askingPrice)}</td>
                  <td className="r num">{money(c.cashFlow)}</td>
                  <td>{c.location ?? "—"}</td>
                  <td>{c.isNew ? <span className="pill accent">New</span> : <span className="pill">Already tracked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
