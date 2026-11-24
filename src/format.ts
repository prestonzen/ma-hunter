export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs % 1e6 === 0 ? 0 : abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1e4) return `$${Math.round(n / 1e3)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

export const fullMoney = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US")}`);

export function ago(ms: number | null | undefined): string {
  if (!ms) return "—";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 0) return inFuture(-m);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
}

function inFuture(m: number): string {
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 36 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}

export const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
export const dateTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export function days(n: number | undefined): string {
  if (n == null) return "—";
  if (n < 1) return "today";
  if (n < 60) return `${n} d`;
  if (n < 365) return `${Math.round(n / 30)} mo`;
  return `${(n / 365).toFixed(1)} yr`;
}

const SOURCE_NAMES: Record<string, string> = {
  bizbuysell: "BizBuySell", bizquest: "BizQuest", flippa: "Flippa", empireflippers: "Empire Flippers", acquire: "Acquire.com", loopnet: "LoopNet",
  businessbroker: "BusinessBroker.net", businessesforsale: "BusinessesForSale", quietlight: "Quiet Light", websiteclosers: "Website Closers",
  feinternational: "FE International", dealstream: "DealStream", manual: "Added by hand",
};
export const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;

export const TRI_LABEL: Record<string, string> = { yes: "Yes", no: "No", unknown: "Not stated", transition: "Transition only", partial: "Partly", absentee: "Absentee", semi: "Semi-absentee", operator: "Owner-operator" };

/** Good / caution / bad / unknown, for the yes-no-unknown chips. */
export function tone(field: string, v: string): "good" | "warn" | "bad" | "none" {
  if (v === "unknown") return "none";
  if (v === "yes") return "good";
  if (v === "transition" || v === "partial" || v === "semi") return "warn";
  if (v === "absentee") return "good";
  if (v === "operator") return field === "ownerRole" ? "warn" : "none";
  return "bad";
}

export const fitTone = (n: number) => (n >= 80 ? "good" : n >= 60 ? "warn" : n > 0 ? "low" : "bad");
