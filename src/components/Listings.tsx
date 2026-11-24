import { useEffect, useState } from "react";
import { STAGES, STAGE_LABEL, type Facets, type Listing } from "../../shared/types";
import { api, type ListQuery, type SequenceRow } from "../api";
import { TRI_LABEL, ago, days, fitTone, money, sourceName, tone } from "../format";

interface Props {
  version: number;
  onOpen: (id: number) => void;
  onChanged: () => void;
}

const COLUMNS: { key: string; label: string; sort?: string; right?: boolean; title?: string }[] = [
  { key: "fit", label: "Fit", sort: "fit", title: "How well it matches your buy box, 0 to 100" },
  { key: "title", label: "Business", sort: "title" },
  { key: "price", label: "Asking", sort: "price", right: true },
  { key: "cashFlow", label: "Cash flow", sort: "cashFlow", right: true },
  { key: "multiple", label: "Multiple", sort: "multiple", right: true },
  { key: "daysOnline", label: "Online", sort: "daysOnline", right: true, title: "How long the listing has been on the market" },
  { key: "financing", label: "Seller financing" },
  { key: "stays", label: "Owner stays" },
  { key: "remote", label: "Remote" },
  { key: "synergy", label: "Synergy", sort: "synergy", title: "0 to 5, from your synergy keywords or set by hand" },
  { key: "reason", label: "Reason for selling" },
  { key: "contacted", label: "Contacted", sort: "contacted" },
  { key: "stage", label: "Stage", sort: "stage" },
];

const PAGE = 100;

/** Every listing in one sortable, filterable table: the "one dashboard" for all the marketplaces. */
export default function Listings({ version, onOpen, onChanged }: Props) {
  const [q, setQ] = useState<ListQuery>({ sort: "fit", dir: "desc", status: "active,pending", hideDups: true });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: Listing[]; total: number; facets: Facets } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .listings({ ...q, q: search, limit: PAGE, offset: page * PAGE })
        .then((r) => {
          setData(r);
          setErr(null);
        })
        .catch((e: Error) => setErr(e.message));
    }, 180);
    return () => clearTimeout(t);
  }, [q, search, page, version]);

  useEffect(() => {
    api.sequences().then((s) => setSequences(s.filter((x) => x.target === "listing" && x.enabled))).catch(() => {});
  }, []);

  const set = (patch: ListQuery) => {
    setPage(0);
    setQ((cur) => ({ ...cur, ...patch }));
  };
  const sortBy = (key: string) => set(q.sort === key ? { dir: q.dir === "desc" ? "asc" : "desc" } : { sort: key, dir: key === "title" ? "asc" : "desc" });
  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = (action: { patch?: Record<string, unknown>; sequenceId?: number }, verb: string) => {
    api
      .bulk([...picked], action)
      .then((r) => {
        setNote(`${verb} ${r.ok} listing${r.ok === 1 ? "" : "s"}${r.errors.length ? `. Skipped ${r.errors.length}: ${r.errors.slice(0, 3).join("; ")}` : ""}`);
        setPicked(new Set());
        onChanged();
      })
      .catch((e: Error) => setNote(e.message));
  };

  const items = data?.items ?? [];
  const select = (key: string, label: string, options: [string, string][]) => (
    <select value={String(q[key] ?? "")} onChange={(e) => set({ [key]: e.target.value || undefined })} aria-label={label}>
      <option value="">{label}: any</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Search title, industry, location…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(0))} />
        {select("stage", "Stage", STAGES.map((s) => [s, `${STAGE_LABEL[s]} (${data?.facets.stages[s] ?? 0})`]))}
        {select("source", "Source", (data?.facets.sources ?? []).map((s) => [s.value, `${sourceName(s.value)} (${s.n})`]))}
        {select("industry", "Industry", (data?.facets.industries ?? []).map((s) => [s.value, `${s.value} (${s.n})`]))}
        {select("sellerFinancing", "Seller financing", [["yes", "Yes"], ["no", "No"], ["unknown", "Not stated"]])}
        {select("ownerStays", "Owner stays", [["yes,transition", "Yes or transition"], ["yes", "Yes"], ["no", "No"], ["unknown", "Not stated"]])}
        {select("remote", "Remote", [["yes", "Yes"], ["yes,partial", "Yes or partly"], ["no", "No"], ["unknown", "Not stated"]])}
        {select("contacted", "Contacted", [["no", "Not yet"], ["yes", "Contacted"], ["replied", "Replied"]])}
        {select("minFit", "Fit", [["80", "80+"], ["60", "60+"], ["40", "40+"]])}
        <select value={String(q.status ?? "")} onChange={(e) => set({ status: e.target.value || undefined })} aria-label="Status">
          <option value="active,pending">For sale</option>
          <option value="sold,removed">Sold or removed</option>
          <option value="">Any status</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={!!q.starred} onChange={(e) => set({ starred: e.target.checked || undefined })} /> Starred
        </label>
        <label className="check small" title="Hide a listing that looks like the same business on another marketplace">
          <input type="checkbox" checked={!!q.hideDups} onChange={(e) => set({ hideDups: e.target.checked || undefined })} /> Hide duplicates
        </label>
        <span className="grow" />
        <button className="ghost" onClick={() => setAdding((a) => !a)}>
          {adding ? "Close" : "Add listing"}
        </button>
        <a className="btn ghost" href={api.csvUrl({ ...q, q: search })}>
          Export CSV
        </a>
      </div>

      {adding && <AddListing onDone={(id) => (setAdding(false), onChanged(), onOpen(id))} />}

      {picked.size > 0 && (
        <div className="bulkbar">
          <b>{picked.size} selected</b>
          <select defaultValue="" onChange={(e) => e.target.value && (bulk({ patch: { stage: e.target.value } }, "Moved"), (e.target.value = ""))} aria-label="Move to stage">
            <option value="">Move to stage…</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </select>
          <select defaultValue="" onChange={(e) => e.target.value && (bulk({ sequenceId: Number(e.target.value) }, "Started outreach for"), (e.target.value = ""))} aria-label="Start outreach">
            <option value="">Start outreach…</option>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="ghost mini" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}
      {note && (
        <p className="ok small">
          {note}{" "}
          <button className="link" onClick={() => setNote(null)}>
            dismiss
          </button>
        </p>
      )}
      {err && <p className="err">{err}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={items.length > 0 && items.every((l) => picked.has(l.id))}
                  onChange={(e) => setPicked(e.target.checked ? new Set(items.map((l) => l.id)) : new Set())}
                />
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`${c.sort ? "sort" : ""}${c.right ? " r" : ""}`} title={c.title} onClick={c.sort ? () => sortBy(c.sort!) : undefined}>
                  {c.label}
                  {c.sort && q.sort === c.sort ? (q.dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id} className={`click${l.status === "sold" || l.status === "removed" || l.stage === "passed" ? " dim" : ""}`} onClick={() => onOpen(l.id)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.title}`} />
                </td>
                <td>
                  <span className={`fit ${fitTone(l.fitScore)}`}>{l.fitScore}</span>
                </td>
                <td className="title">
                  <b>
                    {l.starred ? "★ " : ""}
                    {l.title}
                  </b>
                  <span className="muted small">
                    {sourceName(l.source)}
                    {l.industry ? ` · ${l.industry}` : ""}
                    {l.location ? ` · ${l.location}` : ""}
                    {l.status !== "active" ? ` · ${l.status === "pending" ? "sale pending" : l.status}` : ""}
                    {l.dupOf ? " · possible duplicate" : ""}
                  </span>
                </td>
                <td className="r num">{money(l.askingPrice)}</td>
                <td className="r num">{money(l.cashFlow ?? l.ebitda)}</td>
                <td className="r num">{l.multiple != null ? `${l.multiple.toFixed(1)}x` : "—"}</td>
                <td className="r num nowrap" title={l.listedAt ? `Listed ${new Date(l.listedAt).toLocaleDateString()}` : `First seen ${new Date(l.firstSeen).toLocaleDateString()} (listing date unknown)`}>
                  {days(l.daysOnline)}
                  {!l.listedAt && "+"}
                </td>
                <td>
                  <Chip field="sellerFinancing" v={l.sellerFinancing} title={l.financingNotes} extra={l.sbaEligible === "yes" ? "SBA" : undefined} />
                </td>
                <td>
                  <Chip field="ownerStays" v={l.ownerStays} title={l.transitionNotes} />
                </td>
                <td>
                  <Chip field="remoteManageable" v={l.remoteManageable} title={l.ownerRole !== "unknown" ? `${TRI_LABEL[l.ownerRole]}${l.ownerHours ? `, ${l.ownerHours} h/week` : ""}` : null} />
                </td>
                <td className="num">{(l.synergyOverride ?? l.synergy) > 0 ? `${l.synergyOverride ?? l.synergy}/5` : "—"}</td>
                <td className="reason">{l.reasonForSelling ?? "—"}</td>
                <td className="nowrap small">{l.repliedAt ? <span className="pill good">Replied {ago(l.repliedAt)}</span> : l.contactedAt ? `${ago(l.lastContactAt)}${l.contactCount > 1 ? ` (${l.contactCount}x)` : ""}` : <span className="muted">No</span>}</td>
                <td>
                  <span className={`pill${l.stage === "new" ? "" : " accent"}`}>{STAGE_LABEL[l.stage]}</span>
                </td>
              </tr>
            ))}
            {data && !items.length && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="muted" style={{ padding: 24 }}>
                  No listings match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <div className="row spread small muted" style={{ marginTop: 10 }}>
          <span>
            {data.total === 0 ? "0" : `${page * PAGE + 1}–${Math.min(data.total, (page + 1) * PAGE)}`} of {data.total.toLocaleString()}
          </span>
          <span className="row">
            <button className="ghost mini" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="ghost mini" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </span>
        </div>
      )}
    </>
  );
}

export function Chip({ field, v, title, extra }: { field: string; v: string; title?: string | null; extra?: string }) {
  const t = tone(field, v);
  return (
    <span className="nowrap" title={title ?? undefined}>
      <span className={`pill${t === "none" ? "" : ` ${t}`}`}>{TRI_LABEL[v] ?? v}</span>
      {extra && <span className="pill good" style={{ marginLeft: 4 }}>{extra}</span>}
    </span>
  );
}

/** Add one listing: paste its URL (the hub reads the page) or type the basics by hand. */
function AddListing({ onDone }: { onDone: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [cash, setCash] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fromUrl = () => {
    setBusy(true);
    setErr(null);
    api
      .saveUrl(url.trim(), {} as never)
      .then((r) => onDone(r.results[0].id))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const byHand = () => {
    setBusy(true);
    setErr(null);
    api
      .createListing({ title, url: url.trim() || null, askingPrice: price ? Number(price.replace(/[$,]/g, "")) : null, cashFlow: cash ? Number(cash.replace(/[$,]/g, "")) : null })
      .then((d) => onDone(d.listing.id))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <h3>Add a listing</h3>
      <div className="form-grid">
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          Listing URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label className="field">
          Title <span className="hint">(only needed when adding by hand)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          Asking price
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">
          Cash flow
          <input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button disabled={busy || !/^https?:\/\//i.test(url.trim())} onClick={fromUrl}>
          {busy ? "Working…" : "Read the page and add"}
        </button>
        <button className="ghost" disabled={busy || !title.trim()} onClick={byHand}>
          Add by hand
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      <p className="hint">BizBuySell, BizQuest, Flippa and LoopNet refuse server requests. For those, use the browser clipper or a browser search (Sources tab).</p>
    </section>
  );
}
