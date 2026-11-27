import { useEffect, useMemo, useState } from "react";
import { NdaPanel } from "./Ndas";
import { ValuationPanel } from "./Quant";
import { annualPayment as payment } from "../../shared/underwrite";
import { STAGES, STAGE_LABEL, type Listing, type ListingDetail as Detail } from "../../shared/types";
import { api, type SequenceRow } from "../api";
import { TRI_LABEL, ago, date, dateTime, days, fitTone, fullMoney, money, sourceName } from "../format";
import { Meter } from "./Charts";
import { Chip } from "./Listings";

interface Props {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}

type Draft = Record<string, string>;

const TEXT_FIELDS = ["title", "url", "industry", "model", "location", "realEstate", "reasonForSelling", "financingNotes", "transitionNotes", "synergyNotes"] as const;
const NUM_FIELDS = ["askingPrice", "revenue", "cashFlow", "ebitda", "inventory", "ffe", "established", "employees", "ownerHours"] as const;
const ENUM_FIELDS = ["sellerFinancing", "sbaEligible", "ownerRole", "ownerStays", "remoteManageable"] as const;
const OPTIONS: Record<string, string[]> = {
  sellerFinancing: ["unknown", "yes", "no"],
  sbaEligible: ["unknown", "yes", "no"],
  ownerRole: ["unknown", "absentee", "semi", "operator"],
  ownerStays: ["unknown", "yes", "transition", "no"],
  remoteManageable: ["unknown", "yes", "partial", "no"],
};

const toDraft = (l: Listing): Draft => {
  const d: Draft = {};
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS, ...ENUM_FIELDS]) d[f] = (l as unknown as Record<string, unknown>)[f] == null ? "" : String((l as unknown as Record<string, unknown>)[f]);
  d.listedAt = l.listedAt ? new Date(l.listedAt).toISOString().slice(0, 10) : "";
  d.description = l.description ?? "";
  return d;
};

export default function ListingDetail({ id, onClose, onChanged }: Props) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    setD(null);
    setEditing(false);
    api.listing(id).then(setD).catch((e: Error) => setErr(e.message));
    api.sequences().then(setSequences).catch(() => {});
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Run a change, show the fresh detail, and tell the other views to reload. */
  const run = (p: Promise<Detail>) =>
    p
      .then((next) => {
        setD(next);
        setErr(null);
        onChanged();
      })
      .catch((e: Error) => setErr(e.message));

  if (err && !d) {
    return (
      <div className="scrim" onClick={onClose}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          <p className="err">{err}</p>
          <button onClick={onClose}>Close</button>
        </aside>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="scrim" onClick={onClose}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          <p className="notice">Loading…</p>
        </aside>
      </div>
    );
  }

  const l = d.listing;
  const patch = (p: Record<string, unknown>) => run(api.patchListing(id, p));

  const save = () => {
    const before = toDraft(l);
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v === before[k]) continue;
      if (k === "listedAt") p.listedAt = v ? Date.parse(`${v}T12:00:00Z`) : null;
      else if ((NUM_FIELDS as readonly string[]).includes(k)) p[k] = v.trim() === "" ? null : Number(v.replace(/[$,\s]/g, ""));
      else p[k] = v;
    }
    setEditing(false);
    if (Object.keys(p).length) void patch(p);
  };

  const field = (k: string) => ({ value: draft[k] ?? "", onChange: (e: { target: { value: string } }) => setDraft((c) => ({ ...c, [k]: e.target.value })) });
  const fact = (label: string, key: string, shown: React.ReactNode, kind: "text" | "num" | "enum" | "date" = "text") => (
    <div className="fact">
      <div className="k">{label}</div>
      {editing ? (
        kind === "enum" ? (
          <select {...field(key)}>
            {OPTIONS[key].map((o) => (
              <option key={o} value={o}>
                {TRI_LABEL[o] ?? o}
              </option>
            ))}
          </select>
        ) : (
          <input {...field(key)} type={kind === "date" ? "date" : "text"} inputMode={kind === "num" ? "numeric" : undefined} />
        )
      ) : (
        <div className="v">{shown}</div>
      )}
    </div>
  );

  const listingSequences = sequences.filter((s) => s.target === "listing" && s.enabled);
  const activeOutreach = d.messages.some((m) => m.direction === "out" && ["draft", "approved", "sending"].includes(m.status));

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={l.title}>
        <div className="drawer-head">
          <div className="grow">
            <div className="row small muted" style={{ marginBottom: 4 }}>
              <span>
                {sourceName(l.source)} #{l.sourceId}
              </span>
              {l.url && (
                <a href={l.url} target="_blank" rel="noreferrer noopener">
                  Open listing ↗
                </a>
              )}
              {l.status !== "active" && <span className={`pill ${l.status === "pending" ? "warn" : "bad"}`}>{l.status === "pending" ? "Sale pending" : l.status}</span>}
              {d.duplicate && (
                <span className="pill warn">
                  Possible duplicate of <a href={`#listings/${d.duplicate.id}`}>{d.duplicate.title.slice(0, 40)}</a> on {sourceName(d.duplicate.source)}
                </span>
              )}
            </div>
            {editing ? <input {...field("title")} style={{ width: "100%", fontSize: 18, fontWeight: 700 }} /> : <h1>{l.title}</h1>}
          </div>
          <button className={`star${l.starred ? " on" : ""}`} title={l.starred ? "Remove star" : "Star this listing"} onClick={() => void patch({ starred: l.starred ? 0 : 1 })}>
            ★
          </button>
          <button className="ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        {err && <p className="err">{err}</p>}

        <div className="stack">
          <section className="card">
            <div className="row spread" style={{ marginBottom: 12 }}>
              <div className="row">
                <span className={`fit ${fitTone(l.fitScore)}`} style={{ fontSize: 18, padding: "4px 10px" }} title="Fit score">
                  {l.fitScore}
                </span>
                <label className="row small muted">
                  Stage
                  <select value={l.stage} onChange={(e) => void patch({ stage: e.target.value })}>
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="row small muted">
                  Status
                  <select value={l.status} onChange={(e) => void patch({ status: e.target.value })}>
                    <option value="active">For sale</option>
                    <option value="pending">Sale pending</option>
                    <option value="sold">Sold</option>
                    <option value="removed">Removed</option>
                  </select>
                </label>
              </div>
              {editing ? (
                <div className="row">
                  <button onClick={save}>Save</button>
                  <button className="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="ghost"
                  onClick={() => {
                    setDraft(toDraft(l));
                    setEditing(true);
                  }}
                >
                  Edit details
                </button>
              )}
            </div>

            <div className="facts">
              {fact("Asking price", "askingPrice", fullMoney(l.askingPrice), "num")}
              {fact("Cash flow (SDE)", "cashFlow", fullMoney(l.cashFlow), "num")}
              {fact("Revenue", "revenue", fullMoney(l.revenue), "num")}
              {fact("EBITDA", "ebitda", fullMoney(l.ebitda), "num")}
              <div className="fact">
                <div className="k">Multiple</div>
                <div className="v">{l.multiple != null ? `${l.multiple.toFixed(2)}x ${l.cashFlow ? "cash flow" : "EBITDA"}` : "—"}</div>
              </div>
              {fact("Listed on", "listedAt", l.listedAt ? `${date(l.listedAt)} (${days(l.daysOnline)} online)` : `Unknown; tracked ${days(l.daysOnline)}`, "date")}
              {fact("Industry", "industry", l.industry ?? "—")}
              {fact("Business model", "model", l.model ?? "—")}
              {fact("Location", "location", l.location ?? "—")}
              {fact("Established", "established", l.established ?? "—", "num")}
              {fact("Employees", "employees", l.employees ?? "—", "num")}
              {fact("Inventory", "inventory", money(l.inventory), "num")}
              {fact("FF&E", "ffe", money(l.ffe), "num")}
              {fact("Real estate", "realEstate", l.realEstate ?? "—")}
              {editing && fact("Listing URL", "url", "")}
            </div>
          </section>

          <section className="card">
            <h2>What to know before the first call</h2>
            <div className="facts">
              {fact("Seller financing", "sellerFinancing", <Chip field="sellerFinancing" v={l.sellerFinancing} extra={l.sbaEligible === "yes" ? "SBA" : undefined} />, "enum")}
              {fact("SBA eligible", "sbaEligible", <Chip field="sbaEligible" v={l.sbaEligible} />, "enum")}
              {fact("Owner stays on", "ownerStays", <Chip field="ownerStays" v={l.ownerStays} />, "enum")}
              {fact("Manageable remotely", "remoteManageable", <Chip field="remoteManageable" v={l.remoteManageable} />, "enum")}
              {fact("Owner's role", "ownerRole", <Chip field="ownerRole" v={l.ownerRole} />, "enum")}
              {fact("Owner hours / week", "ownerHours", l.ownerHours ?? "—", "num")}
            </div>
            <div className="facts" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
              {fact("Reason for selling", "reasonForSelling", <span style={{ fontWeight: 400 }}>{l.reasonForSelling ?? "Not stated: ask"}</span>)}
              {fact("Financing notes", "financingNotes", <span style={{ fontWeight: 400 }}>{l.financingNotes ?? "—"}</span>)}
              {fact("Transition / training", "transitionNotes", <span style={{ fontWeight: 400 }}>{l.transitionNotes ?? "—"}</span>)}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <label className="row small muted" title="How well this fits with what you already own. Leave on automatic to use your synergy keywords.">
                Synergy
                <select value={l.synergyOverride == null ? "" : String(l.synergyOverride)} onChange={(e) => void patch({ synergyOverride: e.target.value === "" ? null : Number(e.target.value) })}>
                  <option value="">Automatic ({l.synergy}/5)</option>
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}/5
                    </option>
                  ))}
                </select>
              </label>
              <label className="row small muted">
                NDA
                <select value={l.ndaStatus} onChange={(e) => void patch({ ndaStatus: e.target.value })}>
                  <option value="none">Not yet</option>
                  <option value="requested">Requested</option>
                  <option value="signed">Signed</option>
                </select>
              </label>
              <label className="check small">
                <input type="checkbox" checked={!!l.cimReceived} onChange={(e) => void patch({ cimReceived: e.target.checked ? 1 : 0 })} /> CIM received
              </label>
            </div>
            {editing ? (
              <label className="field" style={{ marginTop: 12 }}>
                Synergy notes
                <input {...field("synergyNotes")} />
              </label>
            ) : (
              l.synergyNotes && <p className="small muted">Synergy: {l.synergyNotes}</p>
            )}
            {l.locked.length > 0 && !editing && (
              <p className="hint" style={{ marginBottom: 0 }}>
                Edited by hand (imports won't overwrite): {l.locked.join(", ")}.{" "}
                <button className="link" onClick={() => void patch({ unlock: l.locked })}>
                  Let imports update them again
                </button>
              </p>
            )}
          </section>

          <div className="grid" style={{ marginBottom: 0 }}>
            <section className="card">
              <h2>Why it scores {l.fitScore}</h2>
              <div className="breakdown">
                {l.fitBreakdown.map((p) => (
                  <div className="b" key={p.label}>
                    <span>{p.label}</span>
                    <span className="pts">
                      {p.points} / {p.max}
                    </span>
                    <span>
                      <Meter value={p.points} max={p.max} />
                      <span className="small muted">{p.note}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <Calculator l={l} />
          </div>

          <section className="card">
            <h2>Contact and outreach</h2>
            <ContactBlock d={d} run={run} />
            <div className="row" style={{ margin: "12px 0" }}>
              <select
                defaultValue=""
                disabled={activeOutreach}
                onChange={(e) => {
                  if (e.target.value) void run(api.enroll(id, Number(e.target.value)));
                  e.target.value = "";
                }}
                aria-label="Start outreach"
              >
                <option value="">{activeOutreach ? "Outreach is in progress" : "Start outreach…"}</option>
                {listingSequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <LogContact onLog={(channel, text) => void run(api.logContact(id, channel, text))} />
              <span className="small muted">
                {l.contactedAt ? `First contacted ${date(l.contactedAt)}, ${l.contactCount} time${l.contactCount === 1 ? "" : "s"}` : "Not contacted yet"}
                {l.repliedAt ? `; replied ${ago(l.repliedAt)}` : ""}
              </span>
            </div>
            <div className="stack">
              {d.messages.map((m) => (
                <div key={m.id} className={`msg${m.direction === "in" ? " in" : ""}`}>
                  <div className="msg-head">
                    <span>
                      <b>{m.direction === "in" ? `Reply from ${m.fromEmail ?? "the contact"}` : m.channel === "form" ? "Contact form message" : `To ${m.toEmail}`}</b>
                      {m.direction === "out" && m.step > 0 ? ` · follow-up ${m.step}` : ""}
                      {m.classification ? ` · ${m.classification.replace(/_/g, " ")}` : ""}
                    </span>
                    <span>
                      <span className={`pill ${m.status === "sent" || m.status === "received" ? "good" : m.status === "failed" || m.status === "needs_human" ? "bad" : m.status === "skipped" ? "" : "warn"}`}>
                        {m.status === "draft" ? "Waiting for approval" : m.status === "approved" ? `Scheduled ${ago(m.scheduledAt)}` : m.status === "needs_human" ? "Needs you" : m.status}
                      </span>{" "}
                      {dateTime(m.sentAt ?? m.scheduledAt)}
                    </span>
                  </div>
                  {m.subject && <div className="small" style={{ fontWeight: 600 }}>{m.subject}</div>}
                  <div className="msg-body">{m.body}</div>
                  {m.error && <p className="err small">{m.error}</p>}
                  {m.status === "draft" && (
                    <p className="small" style={{ margin: "6px 0 0" }}>
                      Review and approve it on the <a href="#outreach">Outreach</a> tab.
                    </p>
                  )}
                </div>
              ))}
              {d.messages.length === 0 && <p className="muted small">No messages yet.</p>}
            </div>
          </section>

          <section className="card">
            <h2>Notes</h2>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you learned, red flags, questions for the broker…" className="grow" />
              <button
                disabled={!note.trim()}
                onClick={() => {
                  void run(api.addNote(id, note)).then(() => setNote(""));
                }}
              >
                Add note
              </button>
            </div>
            <ul className="timeline" style={{ marginTop: 12 }}>
              {d.notes.map((n) => (
                <li key={n.id}>
                  <span className="when">
                    {date(n.at)}
                    <br />
                    {n.author}
                  </span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{n.body}</span>
                </li>
              ))}
            </ul>
          </section>

          <ValuationPanel listingId={id} askingPrice={l.askingPrice} earnings={l.cashFlow ?? l.ebitda} ownerHours={l.ownerHours} />

          <NdaPanel listingId={id} onChanged={() => void run(api.listing(id))} />

          <Documents d={d} run={run} reload={() => void run(api.listing(id))} />

          <section className="card">
            <h2>Description</h2>
            {editing ? <textarea rows={8} {...field("description")} /> : <div className="desc">{l.description || <span className="muted">No description captured.</span>}</div>}
            {l.tags.length > 0 && (
              <p className="row" style={{ marginBottom: 0 }}>
                {l.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </p>
            )}
          </section>

          <section className="card">
            <h2>Timeline</h2>
            {d.priceHistory.length > 1 && (
              <p className="small">
                Asking price history: {d.priceHistory.map((p) => `${money(p.askingPrice)} (${date(p.at)})`).join(" → ")}
              </p>
            )}
            <ul className="timeline">
              {d.events.map((e) => (
                <li key={e.id}>
                  <span className="when">{dateTime(e.at)}</span>
                  <span>
                    {e.message} <span className="muted">· {e.actor}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="small muted" style={{ marginBottom: 0 }}>
              First seen {date(l.firstSeen)} · last seen at the source {ago(l.lastSeen)}
            </p>
          </section>

          <div className="row spread">
            <span />
            <button
              className="danger"
              onClick={() => {
                if (window.confirm(`Delete "${l.title}" with its notes, documents and history? This can't be undone.`)) {
                  void api.deleteListing(id).then(() => {
                    onChanged();
                    onClose();
                  });
                }
              }}
            >
              Delete listing
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ContactBlock({ d, run }: { d: Detail; run: (p: Promise<Detail>) => Promise<void> }) {
  const c = d.contact;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "" });
  const start = () => {
    setF({ name: c?.name ?? "", email: c?.email ?? "", phone: c?.phone ?? "", company: c?.company ?? "" });
    setEdit(true);
  };
  if (edit) {
    return (
      <div>
        <div className="form-grid">
          {(["name", "email", "phone", "company"] as const).map((k) => (
            <label className="field" key={k}>
              {k === "name" ? "Broker or owner" : k[0].toUpperCase() + k.slice(1)}
              <input value={f[k]} onChange={(e) => setF((cur) => ({ ...cur, [k]: e.target.value }))} type={k === "email" ? "email" : "text"} />
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            onClick={() => {
              void run(api.setContact(d.listing.id, f)).then(() => setEdit(false));
            }}
          >
            Save contact
          </button>
          <button className="ghost" onClick={() => setEdit(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="row spread">
      <div>
        {c ? (
          <>
            <b>{c.name ?? c.company ?? "Unnamed contact"}</b>
            {c.name && c.company ? <span className="muted"> · {c.company}</span> : null}
            <div className="small">
              {c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">No email: reach them through the listing's contact form</span>}
              {c.phone ? (
                <>
                  {" · "}
                  <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{c.phone}</a>
                </>
              ) : null}
              {c.doNotContact ? <span className="pill bad" style={{ marginLeft: 8 }}>Do not contact</span> : null}
            </div>
          </>
        ) : (
          <span className="muted">No contact yet. Most marketplaces only offer a contact form until the broker replies.</span>
        )}
      </div>
      <button className="ghost mini" onClick={start}>
        {c ? "Edit contact" : "Add contact"}
      </button>
    </div>
  );
}

function LogContact({ onLog }: { onLog: (channel: string, note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("form");
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)} title="Record a call, or a contact form you filled in yourself">
        Log a contact
      </button>
    );
  }
  return (
    <span className="row">
      <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="How you reached them">
        <option value="form">Contact form</option>
        <option value="phone">Phone call</option>
        <option value="email">Email</option>
      </select>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened (optional)" />
      <button
        onClick={() => {
          onLog(channel, text);
          setOpen(false);
          setText("");
        }}
      >
        Save
      </button>
      <button className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

function Documents({ d, run, reload }: { d: Detail; run: (p: Promise<Detail>) => Promise<void>; reload: () => void }) {
  const [kind, setKind] = useState("other");
  const [busy, setBusy] = useState(false);
  return (
    <section className="card">
      <h2>Documents</h2>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type">
          <option value="cim">CIM / offering memo</option>
          <option value="nda">NDA</option>
          <option value="financials">Financials</option>
          <option value="other">Other</option>
        </select>
        <input
          type="file"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            void run(api.upload(d.listing.id, file, kind)).finally(() => {
              setBusy(false);
              e.target.value = "";
            });
          }}
        />
        {busy && <span className="muted small">Uploading…</span>}
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          {d.documents.map((doc) => (
            <tr key={doc.id}>
              <td>
                <a href={`/api/admin/documents/${doc.id}`} target="_blank" rel="noreferrer">
                  {doc.filename}
                </a>
              </td>
              <td>
                <span className="pill">{doc.kind === "snapshot" ? "Listing page snapshot" : doc.kind.toUpperCase()}</span>
              </td>
              <td className="r num muted">{doc.size > 1e6 ? `${(doc.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(doc.size / 1e3))} KB`}</td>
              <td className="muted">{date(doc.uploadedAt)}</td>
              <td className="r">
                <button
                  className="danger mini"
                  onClick={() => {
                    if (window.confirm(`Delete ${doc.filename}?`)) void api.deleteDocument(doc.id).then(reload);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {d.documents.length === 0 && (
            <tr>
              <td className="muted">Nothing uploaded. Listing pages are snapshotted here automatically when clipped or imported, so the details survive after a listing is taken down.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** A quick look at whether the cash flow can carry the debt. An estimate to frame the conversation, not a quote. */
function Calculator({ l }: { l: Listing }) {
  const [down, setDown] = useState(10);
  const [sellerPct, setSellerPct] = useState(l.sellerFinancing === "yes" ? 10 : 0);
  const [rate, setRate] = useState(10.5);
  const [term, setTerm] = useState(10);
  const [salary, setSalary] = useState(l.ownerRole === "operator" ? 80_000 : 0);
  const price = l.askingPrice ?? 0;
  const cash = l.cashFlow ?? l.ebitda ?? 0;

  const r = useMemo(() => {
    const downAmt = (price * down) / 100;
    const sellerAmt = (price * sellerPct) / 100;
    const bank = Math.max(0, price - downAmt - sellerAmt);
    const debt = payment(bank, rate, term) + payment(sellerAmt, 6, 5);
    const afterSalary = cash - salary;
    return { downAmt, sellerAmt, bank, debt, dscr: debt > 0 ? afterSalary / debt : null, left: afterSalary - debt, coc: downAmt > 0 ? ((afterSalary - debt) / downAmt) * 100 : null };
  }, [price, cash, down, sellerPct, rate, term, salary]);

  if (!price || !cash) {
    return (
      <section className="card">
        <h2>Deal math</h2>
        <p className="muted small">Needs an asking price and a cash flow figure. Add them with "Edit details" once the broker shares them.</p>
      </section>
    );
  }
  const n = (v: number, set: (x: number) => void, step = 1) => ({ type: "number", value: v, step, min: 0, onChange: (e: { target: { value: string } }) => set(Number(e.target.value) || 0) });
  return (
    <section className="card">
      <h2>Deal math (estimate)</h2>
      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
        <label className="field">
          Down payment %
          <input {...n(down, setDown)} />
        </label>
        <label className="field">
          Seller note %
          <input {...n(sellerPct, setSellerPct)} />
        </label>
        <label className="field">
          Loan rate %
          <input {...n(rate, setRate, 0.25)} />
        </label>
        <label className="field">
          Loan term (years)
          <input {...n(term, setTerm)} />
        </label>
        <label className="field" title="What it costs to pay someone to do the owner's job, if you won't work in the business">
          Manager salary
          <input {...n(salary, setSalary, 5000)} />
        </label>
      </div>
      <div className="facts" style={{ marginTop: 12 }}>
        <div className="fact">
          <div className="k">Cash in</div>
          <div className="v">{money(r.downAmt)}</div>
        </div>
        <div className="fact">
          <div className="k">Bank loan</div>
          <div className="v">{money(r.bank)}</div>
        </div>
        <div className="fact">
          <div className="k">Debt service / yr</div>
          <div className="v">{money(Math.round(r.debt))}</div>
        </div>
        <div className="fact">
          <div className="k">Coverage (DSCR)</div>
          <div className="v">
            {r.dscr == null ? "—" : `${r.dscr.toFixed(2)}x`}{" "}
            {r.dscr != null && <span className={`pill ${r.dscr >= 1.5 ? "good" : r.dscr >= 1.25 ? "warn" : "bad"}`}>{r.dscr >= 1.5 ? "Comfortable" : r.dscr >= 1.25 ? "Tight" : "Too thin"}</span>}
          </div>
        </div>
        <div className="fact">
          <div className="k">Left after debt</div>
          <div className="v">{money(Math.round(r.left))}</div>
        </div>
        <div className="fact">
          <div className="k">Cash-on-cash</div>
          <div className="v">{r.coc == null ? "—" : `${Math.round(r.coc)}%`}</div>
        </div>
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        Uses the asking price and stated cash flow; seller note figured at 6% over 5 years. Lenders usually want coverage of 1.25x or better.
      </p>
    </section>
  );
}
