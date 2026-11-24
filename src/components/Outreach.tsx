import { useEffect, useState } from "react";
import type { Contact, Message, OutreachSettings, SequenceStep, Template } from "../../shared/types";
import { api, type SequenceRow, type Status } from "../api";
import { ago, dateTime } from "../format";

interface Props {
  version: number;
  onOpen: (id: number) => void;
  onChanged: () => void;
  status: Status | null;
}

const VIEWS = [
  { id: "review", label: "To review" },
  { id: "scheduled", label: "Scheduled" },
  { id: "sent", label: "Sent" },
  { id: "replies", label: "Replies" },
  { id: "brokers", label: "Brokers" },
  { id: "sequences", label: "Sequences" },
  { id: "settings", label: "Sender & limits" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export default function Outreach({ version, onOpen, onChanged, status }: Props) {
  const [view, setView] = useState<View>("review");
  const q = status?.queue;
  return (
    <>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <div className="seg">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
              {v.label}
              {v.id === "review" && q && q.drafts + q.needsHuman + q.failed > 0 ? ` (${q.drafts + q.needsHuman + q.failed})` : ""}
              {v.id === "scheduled" && q && q.approved > 0 ? ` (${q.approved})` : ""}
            </button>
          ))}
        </div>
      </div>
      {view === "review" && <Queue key={`r${version}`} statuses="draft,needs_human,failed" onOpen={onOpen} onChanged={onChanged} review />}
      {view === "scheduled" && <Queue key={`s${version}`} statuses="approved,sending" onOpen={onOpen} onChanged={onChanged} />}
      {view === "sent" && <Queue key={`t${version}`} statuses="sent" direction="out" onOpen={onOpen} onChanged={onChanged} readOnly />}
      {view === "replies" && <Queue key={`i${version}`} statuses="received" onOpen={onOpen} onChanged={onChanged} readOnly />}
      {view === "brokers" && <Brokers onChanged={onChanged} />}
      {view === "sequences" && <Sequences />}
      {view === "settings" && <Settings />}
    </>
  );
}

function Queue({ statuses, direction, onOpen, onChanged, review, readOnly }: { statuses: string; direction?: string; onOpen: (id: number) => void; onChanged: () => void; review?: boolean; readOnly?: boolean }) {
  const [items, setItems] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .messages({ status: statuses, direction })
      .then(setItems)
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses]);

  const after = (p: Promise<unknown>) =>
    p
      .then(() => {
        setErr(null);
        onChanged();
        return load();
      })
      .catch((e: Error) => setErr(e.message));

  if (!items) return err ? <p className="err">{err}</p> : <p className="notice">Loading…</p>;
  const drafts = items.filter((m) => m.status === "draft");

  return (
    <div className="stack">
      {err && <p className="err">{err}</p>}
      {review && (
        <div className="row spread">
          <span className="muted small">
            Nothing goes out until you approve it. Email goes from your Gmail through the bridge; contact-form messages are typed into the listing's own form by the browser runner.
          </span>
          {drafts.length > 1 && (
            <button onClick={() => window.confirm(`Approve all ${drafts.length} drafts as written?`) && void after(api.approve(drafts.map((m) => m.id)))}>Approve all {drafts.length}</button>
          )}
        </div>
      )}
      {items.length === 0 && (
        <p className="notice">
          {review ? "Nothing waiting for you. Start outreach from a listing, or select several on the Listings tab." : statuses === "received" ? "No replies yet." : "Nothing here yet."}
        </p>
      )}
      {items.map((m) => (
        <MessageCard key={m.id} m={m} onOpen={onOpen} after={after} readOnly={readOnly} />
      ))}
    </div>
  );
}

function MessageCard({ m, onOpen, after, readOnly }: { m: Message; onOpen: (id: number) => void; after: (p: Promise<unknown>) => Promise<unknown>; readOnly?: boolean }) {
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body);
  const [expanded, setExpanded] = useState(false);
  const dirty = subject !== m.subject || body !== m.body;
  const editable = !readOnly && ["draft", "approved", "failed", "needs_human"].includes(m.status);
  const isForm = m.channel === "form";
  const [copied, setCopied] = useState(false);

  return (
    <article className={`msg${m.direction === "in" ? " in" : ""}`}>
      <div className="msg-head">
        <span>
          {m.listingId ? (
            <button className="link" onClick={() => onOpen(m.listingId!)}>
              {m.listingTitle ?? `Listing #${m.listingId}`}
            </button>
          ) : (
            <b>{m.contactName ?? "Broker introduction"}</b>
          )}
          {" · "}
          {m.direction === "in" ? `from ${m.fromEmail}` : isForm ? "via the listing's contact form" : `to ${m.contactName ? `${m.contactName} <${m.toEmail}>` : m.toEmail}`}
          {m.direction === "out" && m.step > 0 ? ` · follow-up ${m.step}` : ""}
          {m.sequenceName ? ` · ${m.sequenceName}` : ""}
        </span>
        <span>
          {m.classification && <span className={`pill ${m.classification === "sold" || m.classification === "not_interested" || m.classification === "bounce" ? "bad" : m.classification === "auto_reply" ? "" : "good"}`}>{m.classification.replace(/_/g, " ")}</span>}{" "}
          {m.status === "needs_human" && <span className="pill bad">Needs you</span>} {m.status === "failed" && <span className="pill bad">Failed</span>}{" "}
          {m.status === "sending" && <span className="pill warn">Sending now</span>}{" "}
          {m.status === "approved" ? `goes out ${ago(m.scheduledAt)}` : dateTime(m.sentAt ?? m.scheduledAt ?? m.createdAt)}
        </span>
      </div>

      {editable ? (
        <div className="stack" style={{ gap: 8 }}>
          {!isForm && <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" style={{ width: "100%", fontWeight: 600 }} />}
          <textarea rows={Math.min(16, Math.max(6, body.split("\n").length + 1))} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        </div>
      ) : (
        <>
          {m.subject && <div className="small" style={{ fontWeight: 600 }}>{m.subject}</div>}
          <div className={`msg-body${expanded || m.body.length < 500 ? "" : " clip"}`}>{m.body}</div>
          {m.body.length >= 500 && (
            <button className="link small" onClick={() => setExpanded((x) => !x)}>
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </>
      )}
      {m.error && <p className="err small">{m.error}</p>}

      {editable && (
        <div className="row" style={{ marginTop: 8 }}>
          {m.status === "draft" || m.status === "failed" || m.status === "needs_human" ? (
            <button onClick={() => void after(api.patchMessage(m.id, { ...(dirty ? { subject, body } : {}), status: "approved" }))}>
              {dirty ? "Save and approve" : m.status === "draft" ? "Approve" : "Try again"}
            </button>
          ) : (
            <button className="ghost" onClick={() => void after(api.patchMessage(m.id, { status: "draft" }))}>
              Hold for review
            </button>
          )}
          {dirty && (
            <button className="ghost" onClick={() => void after(api.patchMessage(m.id, { subject, body }))}>
              Save changes
            </button>
          )}
          {isForm && m.url && (
            <>
              <button
                className="ghost"
                title="Copies the message and opens the listing so you can paste it into the contact form yourself"
                onClick={() => {
                  void navigator.clipboard.writeText(body).then(() => setCopied(true));
                  window.open(m.url!, "_blank", "noopener");
                }}
              >
                {copied ? "Copied. Paste it into the form" : "Copy and open listing"}
              </button>
              <button className="ghost" onClick={() => void after(api.markSent(m.id))}>
                I sent it by hand
              </button>
            </>
          )}
          <span className="grow" />
          <button className="danger" onClick={() => window.confirm("Skip this message and stop the sequence?") && void after(api.patchMessage(m.id, { status: "skipped" }))}>
            Skip and stop
          </button>
        </div>
      )}
    </article>
  );
}

function Brokers({ onChanged }: { onChanged: () => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", email: "", company: "" });
  const load = () => api.contacts().then(setContacts).catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    void load();
    api.sequences().then((s) => setSequences(s.filter((x) => x.target === "broker" && x.enabled))).catch(() => {});
  }, []);
  if (!contacts) return <p className="notice">Loading…</p>;
  const act = (p: Promise<unknown>, done: string) =>
    p
      .then(() => {
        setMsg(done);
        onChanged();
        return load();
      })
      .catch((e: Error) => setMsg(e.message));

  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Brokers see deals before they're listed. Introduce yourself with your buy box so they think of you first: the introduction is filled in from the Buy box tab.
      </p>
      <section className="card">
        <h3>Add a broker</h3>
        <div className="row">
          <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input placeholder="Firm" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          <button disabled={!f.email.trim() && !f.name.trim()} onClick={() => void act(api.createContact(f), "Broker added").then(() => setF({ name: "", email: "", company: "" }))}>
            Add
          </button>
        </div>
      </section>
      {msg && <p className="ok small">{msg}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Email</th>
              <th className="r">Listings</th>
              <th>Last emailed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className={c.doNotContact ? "dim" : ""}>
                <td>
                  <b>{c.name ?? "—"}</b>
                  <div className="small muted">{c.company}</div>
                </td>
                <td>{c.email ?? <span className="muted">none yet</span>}</td>
                <td className="r num">{c.listings ?? 0}</td>
                <td className="small">{c.lastContactAt ? ago(c.lastContactAt) : <span className="muted">never</span>}</td>
                <td className="r nowrap">
                  {c.email && !c.doNotContact && sequences[0] && (
                    <button className="ghost mini" onClick={() => void act(api.enrollContact(c.id, sequences[0].id), `Introduction to ${c.name ?? c.email} is waiting in To review`)}>
                      Introduce yourself
                    </button>
                  )}{" "}
                  <button className="ghost mini" onClick={() => void act(api.patchContact(c.id, { doNotContact: c.doNotContact ? 0 : 1 }), c.doNotContact ? "Contact re-enabled" : "Marked do-not-contact")}>
                    {c.doNotContact ? "Allow contact" : "Do not contact"}
                  </button>
                </td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 20 }}>
                  No contacts yet. They're collected from listings as you import them.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const VARIABLES = "{{first_name}} {{business}} {{source}} {{ref_suffix}} {{price_clause}} {{asking_price}} {{industry}} {{location}} {{questions}} {{buyer_intro}} {{buy_box}} {{buy_box_short}} {{my_name}} {{my_company}} {{my_email}} {{my_phone}} {{signature}}";

function Sequences() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => Promise.all([api.templates().then(setTemplates), api.sequences().then(setSequences)]).catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    void load();
  }, []);
  const after = (p: Promise<unknown>, done: string) => p.then(() => (setMsg(done), load())).catch((e: Error) => setMsg(e.message));

  return (
    <div className="stack">
      {msg && <p className="ok small">{msg}</p>}
      <section className="card">
        <h2>Sequences</h2>
        <p className="hint">A sequence sends its steps in order, each one a set number of days after the last, and stops the moment the contact replies. Changes apply to messages not yet written.</p>
        <div className="stack">
          {sequences.map((s) => (
            <SequenceEditor key={s.id} s={s} templates={templates} onSave={(next) => void after(api.saveSequence(next), `Saved "${next.name}"`)} />
          ))}
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Templates</h2>
          <button className="ghost mini" onClick={() => void after(api.saveTemplate({ name: "New template", subject: "Re: {{business}}", body: "Hi {{first_name}},\n\n\n\n{{signature}}" }), "Template added")}>
            New template
          </button>
        </div>
        <p className="hint">
          Placeholders: <code>{VARIABLES}</code>. <code>{"{{questions}}"}</code> asks only for what the listing doesn't already say: financing, reason for selling, whether the owner stays.
        </p>
        <div className="stack">
          {templates.map((t) => (
            <TemplateEditor key={t.id} t={t} onSave={(next) => void after(api.saveTemplate(next), `Saved "${next.name}"`)} onDelete={() => void after(api.deleteTemplate(t.id), "Template deleted")} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SequenceEditor({ s, templates, onSave }: { s: SequenceRow; templates: Template[]; onSave: (s: Partial<SequenceRow>) => void }) {
  const [name, setName] = useState(s.name);
  const [steps, setSteps] = useState<SequenceStep[]>(s.steps);
  const [autoFirst, setAutoFirst] = useState(!!s.autoFirst);
  const [autoFollowups, setAutoFollowups] = useState(!!s.autoFollowups);
  const [enabled, setEnabled] = useState(!!s.enabled);
  const setStep = (i: number, p: Partial<SequenceStep>) => setSteps((cur) => cur.map((st, j) => (j === i ? { ...st, ...p } : st)));
  return (
    <div className="msg">
      <div className="row spread">
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 600, minWidth: 280 }} aria-label="Sequence name" />
        <span className="small muted">
          {s.channel === "form" ? "Contact form" : "Email"} · {s.target === "broker" ? "brokers" : "listings"} · {s.total} started, {s.replied} replied
        </span>
      </div>
      <ol className="steps" style={{ margin: "10px 0" }}>
        {steps.map((st, i) => (
          <li key={i}>
            <span className="row">
              <select value={st.templateId} onChange={(e) => setStep(i, { templateId: Number(e.target.value) })} aria-label={`Step ${i + 1} template`}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {i > 0 && (
                <>
                  <input type="number" min={1} max={90} value={st.delayDays} onChange={(e) => setStep(i, { delayDays: Number(e.target.value) })} style={{ width: 70 }} aria-label="Days to wait" />
                  <span className="small muted">days after the previous one, if no reply</span>
                  <button className="danger mini" onClick={() => setSteps((cur) => cur.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="row">
        {s.channel === "email" && steps.length < 5 && templates[0] && (
          <button className="ghost mini" onClick={() => setSteps((cur) => [...cur, { templateId: templates[0].id, delayDays: 5 }])}>
            Add a follow-up
          </button>
        )}
        <label className="check small" title="When off, the first message waits in To review until you approve it">
          <input type="checkbox" checked={autoFirst} onChange={(e) => setAutoFirst(e.target.checked)} /> Send the first message without review
        </label>
        {s.channel === "email" && (
          <label className="check small">
            <input type="checkbox" checked={autoFollowups} onChange={(e) => setAutoFollowups(e.target.checked)} /> Send follow-ups without review
          </label>
        )}
        <label className="check small">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Switched on
        </label>
        <span className="grow" />
        <button className="mini" onClick={() => onSave({ id: s.id, name, steps, target: s.target, channel: s.channel, autoFirst: autoFirst ? 1 : 0, autoFollowups: autoFollowups ? 1 : 0, enabled: enabled ? 1 : 0 })}>
          Save
        </button>
      </div>
    </div>
  );
}

function TemplateEditor({ t, onSave, onDelete }: { t: Template; onSave: (t: Partial<Template>) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(t.name);
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  if (!open) {
    return (
      <div className="row spread msg">
        <span>
          <b>{t.name}</b> <span className="muted small">· {t.subject}</span>
        </span>
        <button className="ghost mini" onClick={() => setOpen(true)}>
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="msg stack" style={{ gap: 8 }}>
      <div className="form-grid">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Template body" />
      <div className="row">
        <button className="mini" onClick={() => (onSave({ id: t.id, name, subject, body }), setOpen(false))}>
          Save
        </button>
        <button className="ghost mini" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="grow" />
        <button className="danger mini" onClick={() => window.confirm(`Delete the template "${t.name}"?`) && onDelete()}>
          Delete
        </button>
      </div>
    </div>
  );
}

function Settings() {
  const [s, setS] = useState<OutreachSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then((r) => setS(r.outreach)).catch((e: Error) => setMsg(e.message));
  }, []);
  if (!s) return <p className="notice">{msg ?? "Loading…"}</p>;
  const text = (k: keyof OutreachSettings, label: string, hint?: string, wide?: boolean) => (
    <label className="field" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <span>
        {label} {hint && <span className="hint">{hint}</span>}
      </span>
      {wide ? <textarea rows={3} value={String(s[k])} onChange={(e) => setS({ ...s, [k]: e.target.value })} /> : <input value={String(s[k])} onChange={(e) => setS({ ...s, [k]: e.target.value })} />}
    </label>
  );
  const num = (k: keyof OutreachSettings, label: string, hint?: string) => (
    <label className="field">
      <span>
        {label} {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="number" min={0} value={Number(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <section className="card">
      <h2>Who the messages come from</h2>
      <div className="form-grid">
        {text("myName", "Your name")}
        {text("myCompany", "Company")}
        {text("myEmail", "Reply-to email", "(typed into contact forms)")}
        {text("myPhone", "Phone")}
        {text("buyerIntro", "About you as a buyer", "one or two sentences; fills {{buyer_intro}}", true)}
        {text("signature", "Signature", "leave empty to use name, company and phone", true)}
      </div>
      <h2 style={{ marginTop: 20 }}>Pace</h2>
      <div className="form-grid">
        {num("dailyCap", "Emails per day")}
        {num("formDailyCap", "Contact forms per day")}
        {num("perPoll", "Per check-in", "(the bridge checks in every 5 min)")}
        {num("windowStart", "Send from (hour)")}
        {num("windowEnd", "Until (hour)")}
        {text("timezone", "Timezone", "e.g. America/New_York")}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <label className="check">
          <input type="checkbox" checked={s.weekdaysOnly} onChange={(e) => setS({ ...s, weekdaysOnly: e.target.checked })} /> Weekdays only
        </label>
        <label className="check">
          <input type="checkbox" checked={s.paused} onChange={(e) => setS({ ...s, paused: e.target.checked })} /> Pause all outreach
        </label>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button
          onClick={() => {
            api
              .saveOutreach(s)
              .then((r) => (setS(r.outreach), setMsg("Saved")))
              .catch((e: Error) => setMsg(e.message));
          }}
        >
          Save
        </button>
        {msg && <span className="ok small">{msg}</span>}
      </div>
    </section>
  );
}
