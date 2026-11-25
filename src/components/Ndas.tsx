import { useCallback, useEffect, useRef, useState } from "react";
import type { Nda, NdaSettings } from "../../shared/types";
import { api, type NdaList } from "../api";
import { ago, dateTime } from "../format";

const PLACEMENT: Record<Nda["placement"], { label: string; tone: string; title: string }> = {
  generated: { label: "Your NDA", tone: "accent", title: "Written by the hub from your template" },
  anchored: { label: "Signature line found", tone: "good", title: "The buyer's signature line was found and the fields sit on it" },
  guess: { label: "Check the signature spot", tone: "warn", title: "There is more than one signature line and it isn't certain which is yours. Look before you sign." },
  fallback: { label: "No signature line found", tone: "warn", title: "The fields were put at the foot of the last page. Look before you sign." },
};

/** One NDA: what it is, what was flagged, and the next thing to do with it. */
function NdaRow({ n, onOpen, reload, showListing }: { n: Nda; onOpen?: (id: number) => void; reload: () => void; showListing: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    p.then(reload)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const reds = n.flags.filter((f) => f.level === "red");
  const ambers = n.flags.filter((f) => f.level === "amber");
  const place = PLACEMENT[n.placement];
  return (
    <li className="nda">
      <div className="row spread">
        <div>
          <strong>{n.kind === "ours" ? "Your NDA" : "Their NDA"}</strong>
          {showListing && n.listingId && (
            <>
              {" · "}
              <button className="link" onClick={() => onOpen?.(n.listingId!)}>
                {n.listingTitle ?? `Listing #${n.listingId}`}
              </button>
            </>
          )}
          <div className="small muted">
            {n.counterparty ? `${n.counterparty} · ` : ""}
            {n.status === "signed" ? `signed ${ago(n.signedAt)}` : `prepared ${ago(n.createdAt)}`}
          </div>
        </div>
        <div className="row">
          {n.status === "signed" && <span className="pill good">Signed</span>}
          {n.status === "void" && <span className="pill">Cancelled</span>}
          {n.status === "failed" && <span className="pill bad">Not started</span>}
          {n.status === "to_sign" && (
            <span className={`pill ${n.auto ? "accent" : "warn"}`} title={n.auto ? "The browser runner signs this one when it is online" : "Waiting for you"}>
              {n.auto ? "Runner will sign" : "Needs your signature"}
            </span>
          )}
        </div>
      </div>

      {n.kind === "theirs" && n.status !== "void" && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className={`pill ${place.tone}`} title={place.title}>
            {place.label}
          </span>
          {reds.length > 0 && (
            <span className="pill bad">
              {reds.length} to read first
            </span>
          )}
          {ambers.length > 0 && <span className="pill warn">{ambers.length} standard clause{ambers.length === 1 ? "" : "s"} noted</span>}
          {n.flags.length === 0 && <span className="pill good">Nothing unusual found</span>}
          {n.flags.length > 0 && (
            <button className="link small" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Show"} clauses
            </button>
          )}
        </div>
      )}
      {open && (
        <ul className="flags">
          {n.flags.map((f, i) => (
            <li key={i}>
              <span className={`pill ${f.level === "red" ? "bad" : "warn"}`}>{f.label}</span>
              <q className="small">{f.quote}</q>
            </li>
          ))}
        </ul>
      )}

      {n.error && n.status !== "signed" && <p className="err small">{n.error}</p>}
      {err && <p className="err small">{err}</p>}

      <div className="row" style={{ marginTop: 10 }}>
        {n.status === "to_sign" && n.signingUrl && (
          <a className="btn mini" href={n.signingUrl} target="_blank" rel="noreferrer">
            Review and sign
          </a>
        )}
        {n.status === "to_sign" && (
          <button className="ghost mini" disabled={busy} onClick={() => act(api.syncNda(n.id))} title="Ask Documenso whether it has been signed">
            I signed it
          </button>
        )}
        {n.status === "to_sign" && (
          <button className="ghost mini" disabled={busy} onClick={() => act(api.autoNda(n.id, !n.auto))}>
            {n.auto ? "Don't auto-sign" : "Let the runner sign"}
          </button>
        )}
        {n.status === "failed" && (
          <button className="mini" disabled={busy} onClick={() => act(api.retryNda(n.id))}>
            Try again
          </button>
        )}
        {n.sourceDocId && (
          <a className="btn ghost mini" href={`/api/admin/documents/${n.sourceDocId}`} target="_blank" rel="noreferrer">
            Unsigned PDF
          </a>
        )}
        {n.signedDocId && (
          <a className="btn ghost mini" href={`/api/admin/documents/${n.signedDocId}`} target="_blank" rel="noreferrer">
            Signed PDF
          </a>
        )}
        {(n.status === "to_sign" || n.status === "failed") && (
          <button
            className="danger mini"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Cancel this NDA? The signing link stops working.")) act(api.voidNda(n.id));
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

/** In a listing's drawer: start an NDA for this listing, and see the ones it has. */
export function NdaPanel({ listingId, version, onChanged }: { listingId: number; version?: number; onChanged?: () => void }) {
  const [data, setData] = useState<NdaList | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    api.ndas(listingId).then(setData).catch((e: Error) => setErr(e.message));
  }, [listingId]);
  useEffect(load, [load, version]);
  const run = (p: Promise<Nda>) => {
    setBusy(true);
    setErr(null);
    p.then((n) => {
      if (n.status === "failed" && n.error) setErr(n.error);
      load();
      onChanged?.();
    })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <section className="card">
      <h2>NDA</h2>
      {data && !data.configured && <p className="hint">Documenso isn't connected yet, so an NDA can be prepared here but not signed. See the NDAs tab.</p>}
      <div className="row">
        <button className="mini" disabled={busy} onClick={() => run(api.createNda(listingId))}>
          Send my NDA
        </button>
        <button className="ghost mini" disabled={busy} onClick={() => file.current?.click()}>
          Sign their NDA (PDF)
        </button>
        <input
          ref={file}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) run(api.uploadNda(listingId, f));
          }}
        />
        {busy && <span className="small muted">Preparing…</span>}
      </div>
      {err && <p className="err small">{err}</p>}
      {data && data.items.length > 0 && (
        <ul className="ndas">
          {data.items.map((n) => (
            <NdaRow
              key={n.id}
              n={n}
              reload={() => {
                load();
                onChanged?.();
              }}
              showListing={false}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const AUTO: { value: NdaSettings["autoSign"]; label: string; hint: string }[] = [
  { value: "off", label: "Never", hint: "Every NDA waits for your click." },
  { value: "mine", label: "My own NDA", hint: "The runner signs your own NDA. A broker's NDA waits for you." },
  { value: "clean", label: "Mine, and clean ones of theirs", hint: "Also a broker's NDA, when nothing is flagged to read first and the signature line was found." },
];

/** The NDAs tab: everything out for signature, everything signed, and how signing is set up. */
export default function Ndas({ version, onOpen, onChanged }: { version: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const [data, setData] = useState<NdaList | null>(null);
  const [form, setForm] = useState<NdaSettings | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .ndas()
      .then((d) => {
        setData(d);
        setForm((f) => f ?? d.settings);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load, version]);
  if (!data || !form) return <p className="notice">{err ?? "Loading…"}</p>;

  const reload = () => {
    load();
    onChanged();
  };
  const toSign = data.items.filter((n) => n.status === "to_sign");
  const failed = data.items.filter((n) => n.status === "failed");
  const signed = data.items.filter((n) => n.status === "signed");
  const set = <K extends keyof NdaSettings>(k: K, v: NdaSettings[K]) => setForm({ ...form, [k]: v });
  const save = () => {
    setBusy(true);
    setNote(null);
    setErr(null);
    api
      .saveNdaSettings(form)
      .then((r) => {
        setForm(r.settings);
        setNote("Saved. The auto-sign rule applies to NDAs prepared from now on.");
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="stack">
      {!data.configured && (
        <section className="card">
          <h2>Connect Documenso</h2>
          <p>
            NDAs are signed in your Documenso at <strong>{data.documensoUrl ?? "(DOCUMENSO_URL is not set)"}</strong>. The hub needs an API token for it: create one in Documenso under Settings, API tokens, then store it on the Worker:
          </p>
          <pre className="code">npx wrangler secret put DOCUMENSO_TOKEN</pre>
          <p className="hint">Until then, an NDA can be prepared and read here, but the signing link can't be made.</p>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>To sign ({toSign.length})</h2>
          <button
            className="ghost mini"
            onClick={() => {
              setNote(null);
              api
                .syncNdas()
                .then((r) => {
                  setNote(`Checked ${r.checked} with Documenso: ${r.signed} signed.`);
                  reload();
                })
                .catch((e: Error) => setErr(e.message));
            }}
          >
            Check Documenso now
          </button>
        </div>
        {toSign.length === 0 && failed.length === 0 && <p className="muted">Nothing is waiting. An NDA appears here when a broker asks for one, when their reply carries one as a PDF, or when you start one from a listing.</p>}
        <ul className="ndas">
          {[...toSign, ...failed].map((n) => (
            <NdaRow key={n.id} n={n} onOpen={onOpen} reload={reload} showListing />
          ))}
        </ul>
        {note && <p className="ok small">{note}</p>}
        {err && <p className="err small">{err}</p>}
      </section>

      <section className="card">
        <h2>Signed ({signed.length})</h2>
        {signed.length === 0 && <p className="muted">No signed NDAs yet.</p>}
        <ul className="ndas">
          {signed.map((n) => (
            <NdaRow key={n.id} n={n} onOpen={onOpen} reload={reload} showListing />
          ))}
        </ul>
        {signed.length > 0 && <p className="hint">Last signed {dateTime(signed[0].signedAt)}. Signed copies are also in each listing's documents.</p>}
      </section>

      <section className="card">
        <h2>How NDAs are handled</h2>
        <div className="form-grid">
          <label className="field">
            Name that signs
            <input value={form.legalName} onChange={(e) => set("legalName", e.target.value)} placeholder="Defaults to your outreach name" />
          </label>
          <label className="field">
            Title
            <input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Managing Member" />
          </label>
          <label className="field">
            Address
            <input value={form.address} onChange={(e) => set("address", e.target.value)} />
          </label>
          <label className="field">
            Governing law (your NDA)
            <input value={form.state} onChange={(e) => set("state", e.target.value)} placeholder="e.g. the State of Texas" />
          </label>
          <label className="field">
            Term in years (your NDA)
            <input type="number" min={1} max={10} value={form.termYears} onChange={(e) => set("termYears", Number(e.target.value))} />
          </label>
          <label className="field">
            When a broker asks for an NDA and attaches none
            <select value={form.onRequest} onChange={(e) => set("onRequest", e.target.value as NdaSettings["onRequest"])}>
              <option value="send_mine">Prepare mine</option>
              <option value="wait">Wait for theirs</option>
            </select>
          </label>
        </div>

        <h3 style={{ marginTop: 16 }}>Signing without asking</h3>
        <div className="stack" style={{ gap: 6 }}>
          {AUTO.map((o) => (
            <label key={o.value} className="check">
              <input type="radio" name="autoSign" checked={form.autoSign === o.value} onChange={() => set("autoSign", o.value)} />
              <span>
                {o.label} <span className="hint">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="hint">Documenso has no way to sign through its API, so a signature is always made on its signing page: by you, or by the browser runner on your machine for the NDAs this rule clears. The runner needs "sign" among its capabilities.</p>

        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={form.returnByEmail} onChange={(e) => set("returnByEmail", e.target.checked)} />
          Email the signed copy back to the broker, in the same thread
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          Message that goes with it
          <textarea rows={5} value={form.returnMessage} onChange={(e) => set("returnMessage", e.target.value)} />
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          Your NDA
          <textarea rows={14} value={form.template} onChange={(e) => set("template", e.target.value)} />
        </label>
        <p className="hint">
          Variables: {"{{buyer}}"}, {"{{business}}"}, {"{{counterparty}}"}, {"{{term_years}}"}, {"{{state}}"}. The starting text is a plain one-way confidentiality agreement, not legal advice: have your lawyer read it once before it goes out under your name.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
