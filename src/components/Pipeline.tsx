import { useEffect, useState } from "react";
import { ACTIVE_STAGES, STAGE_LABEL, type EventRow, type Listing, type Stage } from "../../shared/types";
import { api } from "../api";
import { ago, days, fitTone, money, sourceName } from "../format";

interface Props {
  version: number;
  onOpen: (id: number) => void;
  onChanged: () => void;
  mock: boolean;
}

/** The deal board: one column per stage, best fit first. Drag a card to move a deal along. */
export default function Pipeline({ version, onOpen, onChanged, mock }: Props) {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [hideNewBelow, setHideNewBelow] = useState(60);

  useEffect(() => {
    api
      .listings({ stage: ACTIVE_STAGES.join(","), status: "active,pending", sort: "fit", limit: 400, hideDups: true })
      .then((r) => setItems(r.items))
      .catch((e: Error) => setErr(e.message));
    api.events(30).then(setEvents).catch(() => {});
  }, [version]);

  const move = (id: number, stage: Stage) => {
    const l = items?.find((x) => x.id === id);
    if (!l || l.stage === stage) return;
    setItems((cur) => cur?.map((x) => (x.id === id ? { ...x, stage } : x)) ?? null); // move at once; the reload confirms
    api
      .patchListing(id, { stage })
      .then(onChanged)
      .catch((e: Error) => {
        setErr(e.message);
        onChanged();
      });
  };

  if (err && !items) return <p className="err">Couldn't load the pipeline: {err}</p>;
  if (!items) return <p className="notice">Loading…</p>;

  if (!items.length) {
    return (
      <section className="card">
        <h3>No listings yet</h3>
        <p className="muted">
          Add your first source on the <a href="#sources">Sources</a> tab: a saved search, a listing URL, or the browser clipper. Set your criteria on the{" "}
          <a href="#buybox">Buy box</a> tab so every listing gets a fit score.
        </p>
        {mock && (
          <button
            onClick={() => {
              void api.demoSeed().then(onChanged);
            }}
          >
            Load demo data
          </button>
        )}
      </section>
    );
  }

  const hiddenNew = items.filter((l) => l.stage === "new" && l.fitScore < hideNewBelow).length;

  return (
    <>
      {err && <p className="err">{err}</p>}
      <div className="row spread" style={{ marginBottom: 10 }}>
        <span className="muted small">Drag a card between columns to change its stage. Click a card for the full picture.</span>
        <label className="row small muted">
          Hide new listings scoring under
          <select value={hideNewBelow} onChange={(e) => setHideNewBelow(Number(e.target.value))}>
            {[0, 40, 60, 75].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "nothing (show all)" : n}
              </option>
            ))}
          </select>
          {hiddenNew > 0 && <span>({hiddenNew} hidden)</span>}
        </label>
      </div>
      <div className="board">
        {ACTIVE_STAGES.map((stage) => {
          const col = items.filter((l) => l.stage === stage && (stage !== "new" || l.fitScore >= hideNewBelow));
          return (
            <div
              key={stage}
              className={`col${over === stage ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((s) => (s === stage ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                move(Number(e.dataTransfer.getData("text/plain")), stage);
              }}
            >
              <div className="col-head">
                {STAGE_LABEL[stage]} <span>{col.length}</span>
              </div>
              {col.map((l) => (
                <article key={l.id} className="deal" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", String(l.id))} onClick={() => onOpen(l.id)}>
                  <div className="t">
                    {l.starred ? "★ " : ""}
                    {l.title}
                  </div>
                  <div className="m">
                    <span className={`fit ${fitTone(l.fitScore)}`} title="Fit score">
                      {l.fitScore}
                    </span>
                    <span className="num">{money(l.askingPrice)}</span>
                    {l.multiple != null && <span className="num">{l.multiple.toFixed(1)}x</span>}
                    <span title="Time on the market">{days(l.daysOnline)}</span>
                  </div>
                  <div className="m">
                    <span>{sourceName(l.source)}</span>
                    {l.sellerFinancing === "yes" && <span className="pill good">Seller financing</span>}
                    {l.repliedAt ? <span className="pill good">Replied</span> : l.contactedAt ? <span className="pill">Contacted {ago(l.lastContactAt)}</span> : null}
                    {l.status === "pending" && <span className="pill warn">Sale pending</span>}
                  </div>
                </article>
              ))}
            </div>
          );
        })}
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>Recent activity</h2>
        {events.length === 0 && <p className="muted small">Nothing yet</p>}
        <ul className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="when">{ago(e.at)}</span>
              <span>
                {e.listingId && e.title ? (
                  <>
                    <button className="link" onClick={() => onOpen(e.listingId!)}>
                      {e.title}
                    </button>
                    {": "}
                  </>
                ) : null}
                {e.message} <span className="muted">· {e.actor}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
