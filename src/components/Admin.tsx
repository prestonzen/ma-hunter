import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, type Status } from "../api";
import { ago } from "../format";
import Analytics from "./Analytics";
import BuyBoxForm from "./BuyBox";
import Connect from "./Connect";
import ListingDetail from "./ListingDetail";
import Listings from "./Listings";
import Outreach from "./Outreach";
import Pipeline from "./Pipeline";
import Sources from "./Sources";

const TABS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "listings", label: "Listings" },
  { id: "outreach", label: "Outreach" },
  { id: "sources", label: "Sources" },
  { id: "buybox", label: "Buy box" },
  { id: "analytics", label: "Analytics" },
  { id: "connect", label: "Connect" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const tabFromHash = (): TabId => {
  const h = window.location.hash.replace("#", "").split("/")[0];
  return (TABS.find((t) => t.id === h)?.id ?? "pipeline") as TabId;
};
const listingFromHash = (): number | null => {
  const m = window.location.hash.match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
};

export default function Admin() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [open, setOpen] = useState<number | null>(listingFromHash);
  // Bumped whenever something changed that other views should re-read.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    api.me().then(() => setAuth("in")).catch((e) => setAuth(e instanceof ApiError && e.status === 401 ? "out" : "out"));
  }, []);

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setOpen(listingFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (auth !== "in") return;
    const load = () => api.status().then(setStatus).catch(() => {});
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => clearInterval(t);
  }, [auth, version]);

  const openListing = useCallback(
    (id: number | null) => {
      window.location.hash = id ? `${tab}/${id}` : tab;
    },
    [tab],
  );

  if (auth === "checking") return <p className="notice">Loading…</p>;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;

  const waiting = (status?.queue.drafts ?? 0) + (status?.queue.needsHuman ?? 0);
  const bridgeOn = !!status?.gmailBridge && Date.now() - status.gmailBridge.at < 20 * 60_000;
  const runnerOn = (status?.runners ?? []).some((r) => Date.now() - r.at < 10 * 60_000);

  return (
    <main>
      <div className="row spread" style={{ marginTop: 12 }}>
        <div className="row small muted">
          <span title={status?.gmailBridge ? `Last check-in ${ago(status.gmailBridge.at)}` : "The Gmail bridge has never checked in. See Connect."}>
            <i className={`dot${bridgeOn ? " on" : ""}`} />
            Gmail {bridgeOn ? `connected${status?.gmailBridge?.account ? ` (${status.gmailBridge.account})` : ""}` : "not connected"}
          </span>
          <span title={status?.runners.length ? status.runners.map((r) => `${r.name}: ${ago(r.at)}`).join(", ") : "No browser runner has checked in. See Connect."}>
            <i className={`dot${runnerOn ? " on" : ""}`} />
            Browser runner {runnerOn ? "online" : "offline"}
          </span>
          {status?.mock && <span className="pill accent">Local demo mode</span>}
        </div>
        {!status?.mock && (
          <button
            className="ghost mini"
            onClick={() => {
              void api.logout().then(() => setAuth("out"));
            }}
          >
            Sign out
          </button>
        )}
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "on" : ""}>
            {t.label}
            {t.id === "outreach" && waiting > 0 && <span className={`count${status?.queue.needsHuman ? " warn" : ""}`}>{waiting}</span>}
          </a>
        ))}
      </nav>

      {tab === "pipeline" && <Pipeline version={version} onOpen={openListing} onChanged={bump} mock={!!status?.mock} />}
      {tab === "listings" && <Listings version={version} onOpen={openListing} onChanged={bump} />}
      {tab === "outreach" && <Outreach version={version} onOpen={openListing} onChanged={bump} status={status} />}
      {tab === "sources" && <Sources status={status} onChanged={bump} />}
      {tab === "buybox" && <BuyBoxForm onChanged={bump} />}
      {tab === "analytics" && <Analytics version={version} />}
      {tab === "connect" && <Connect status={status} />}

      {open && <ListingDetail id={open} onClose={() => openListing(null)} onChanged={bump} />}
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    api
      .login(token.trim())
      .then(onDone)
      .catch((x: Error) => setErr(x.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1 style={{ fontSize: 22 }}>Sign in</h1>
      <label className="field">
        Admin token
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus autoComplete="current-password" />
      </label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy || token.trim().length < 24}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="hint">The token is the ADMIN_TOKEN secret set on the Worker. It's traded for a session cookie that lasts 30 days.</p>
    </form>
  );
}
