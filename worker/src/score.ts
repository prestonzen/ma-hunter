import type { BuyBox, FitPart, Listing } from "./types";

/**
 * Fit score: how well a listing matches the buy box, 0-100, with a breakdown the admin can read.
 * A field the listing doesn't state earns half credit, so a sparse listing lands mid-table rather
 * than at the bottom: unknown is a reason to ask, not a reason to pass. A hard exclusion (an excluded
 * industry or keyword) zeroes the score.
 */

export const DEFAULT_BUY_BOX: BuyBox = {
  priceMin: null,
  priceMax: null,
  cashFlowMin: null,
  multipleMax: null,
  industriesInclude: [],
  industriesExclude: [],
  keywordsExclude: [],
  locations: [],
  requireRemote: false,
  preferSellerFinancing: true,
  preferOwnerStays: true,
  synergyProfile: "",
  synergyKeywords: [],
};

type Scorable = Pick<
  Listing,
  | "title" | "description" | "industry" | "model" | "location" | "state" | "country" | "askingPrice" | "cashFlow" | "ebitda"
  | "sellerFinancing" | "sbaEligible" | "ownerStays" | "remoteManageable" | "reasonForSelling" | "listedAt" | "firstSeen" | "synergyOverride"
>;

const has = (hay: string, needle: string) => {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  // Whole-word match for short terms so "bar" doesn't hit "barber".
  return n.length <= 4 ? new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay) : hay.includes(n);
};

/** Synergy 0-5 from how many of the buy box's synergy keywords the listing mentions. */
export function computeSynergy(l: Scorable, box: BuyBox): number {
  const keys = box.synergyKeywords.map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return 0;
  const hay = `${l.title} ${l.industry ?? ""} ${l.model ?? ""} ${l.description ?? ""}`.toLowerCase();
  const hits = keys.filter((k) => has(hay, k)).length;
  if (!hits) return 0;
  // One hit is already meaningful; more hits saturate quickly.
  return Math.min(5, 2 + hits);
}

export function multipleOf(l: Pick<Listing, "askingPrice" | "cashFlow" | "ebitda">): number | null {
  const earnings = l.cashFlow ?? l.ebitda;
  if (!l.askingPrice || !earnings || earnings <= 0) return null;
  return Math.round((l.askingPrice / earnings) * 100) / 100;
}

const DAY = 86_400_000;
export const daysOnline = (l: Pick<Listing, "listedAt" | "firstSeen">, now = Date.now()) => Math.max(0, Math.floor((now - (l.listedAt ?? l.firstSeen)) / DAY));

const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);

export function computeFit(l: Scorable, box: BuyBox, now = Date.now()): { fitScore: number; fitBreakdown: FitPart[]; synergy: number } {
  const parts: FitPart[] = [];
  const add = (label: string, points: number, max: number, note: string) => parts.push({ label, points: Math.round(points * 10) / 10, max, note });
  const hay = `${l.title} ${l.industry ?? ""} ${l.model ?? ""} ${l.description ?? ""}`.toLowerCase();
  const synergy = computeSynergy(l, box);
  const effectiveSynergy = l.synergyOverride ?? synergy;

  const excludedIndustry = box.industriesExclude.find((x) => has(`${l.industry ?? ""} ${l.model ?? ""} ${l.title}`.toLowerCase(), x));
  const excludedKeyword = box.keywordsExclude.find((x) => has(hay, x));
  if (excludedIndustry || excludedKeyword) {
    add("Excluded", 0, 100, excludedIndustry ? `Industry "${excludedIndustry}" is on your exclude list` : `Mentions "${excludedKeyword}", which you exclude`);
    return { fitScore: 0, fitBreakdown: parts, synergy };
  }

  // Price (20)
  if (l.askingPrice == null) add("Price", 10, 20, "Asking price not stated");
  else if (box.priceMin == null && box.priceMax == null) add("Price", 14, 20, "No price range set in the buy box");
  else if ((box.priceMin == null || l.askingPrice >= box.priceMin) && (box.priceMax == null || l.askingPrice <= box.priceMax)) add("Price", 20, 20, `${fmt(l.askingPrice)} is in range`);
  else if (box.priceMax != null && l.askingPrice > box.priceMax) {
    const over = l.askingPrice / box.priceMax - 1;
    add("Price", over <= 0.25 ? 10 : 0, 20, `${fmt(l.askingPrice)} is ${Math.round(over * 100)}% over your max`);
  } else add("Price", 8, 20, `${fmt(l.askingPrice)} is below your minimum`);

  // Cash flow (15)
  const earnings = l.cashFlow ?? l.ebitda;
  if (earnings == null) add("Cash flow", 7.5, 15, "Cash flow not stated");
  else if (box.cashFlowMin == null) add("Cash flow", 11, 15, "No minimum set in the buy box");
  else if (earnings >= box.cashFlowMin) add("Cash flow", 15, 15, `${fmt(earnings)} meets your minimum`);
  else add("Cash flow", Math.max(0, 15 * (earnings / box.cashFlowMin) - 5), 15, `${fmt(earnings)} is under your ${fmt(box.cashFlowMin)} minimum`);

  // Multiple (15)
  const mult = multipleOf(l);
  if (mult == null) add("Multiple", 7.5, 15, "Can't compute: price or cash flow missing");
  else {
    const cap = box.multipleMax ?? 4;
    if (mult <= cap) add("Multiple", 15, 15, `${mult.toFixed(1)}x cash flow`);
    else add("Multiple", Math.max(0, 15 - (mult - cap) * 6), 15, `${mult.toFixed(1)}x is above your ${cap}x ceiling`);
  }

  // Industry (10)
  if (!box.industriesInclude.length) add("Industry", 7, 10, "No target industries set");
  else {
    const hit = box.industriesInclude.find((x) => has(`${l.industry ?? ""} ${l.model ?? ""} ${l.title}`.toLowerCase(), x)) ?? box.industriesInclude.find((x) => has(hay, x));
    if (hit) add("Industry", 10, 10, `Matches "${hit}"`);
    else add("Industry", l.industry ? 2 : 5, 10, l.industry ? `${l.industry} isn't a target industry` : "Industry not stated");
  }

  // Location / manageability (10)
  const remote = l.remoteManageable;
  const where = `${l.state ?? ""} ${l.location ?? ""} ${l.country ?? ""}`.toLowerCase();
  const inArea = box.locations.length ? box.locations.some((x) => (x.trim().length === 2 ? (l.state ?? "").toLowerCase() === x.trim().toLowerCase() : has(where, x))) : null;
  if (remote === "yes") add("Manageable", 10, 10, "Can be run remotely");
  else if (inArea === true) add("Manageable", remote === "no" ? 8 : 9, 10, `Located in your area (${l.state ?? l.location})`);
  else if (box.requireRemote) add("Manageable", remote === "partial" ? 4 : remote === "unknown" ? 3 : 0, 10, remote === "partial" ? "Partly remote (manager or staff in place)" : remote === "unknown" ? "Remote manageability not stated" : "Needs an owner on site");
  else if (inArea === false) add("Manageable", remote === "partial" ? 5 : 2, 10, `Outside your target locations${remote === "partial" ? ", partly remote" : ""}`);
  else add("Manageable", remote === "partial" ? 7 : 5, 10, remote === "partial" ? "Partly remote (manager or staff in place)" : remote === "unknown" ? "Remote manageability not stated" : "Needs an owner on site");

  // Financing (10)
  if (l.sellerFinancing === "yes") add("Financing", 10, 10, l.sbaEligible === "yes" ? "Seller financing offered, SBA eligible" : "Seller financing offered");
  else if (l.sbaEligible === "yes") add("Financing", 8, 10, "SBA pre-qualified");
  else if (l.sellerFinancing === "no") add("Financing", box.preferSellerFinancing ? 0 : 5, 10, "Seller won't finance");
  else add("Financing", 5, 10, "Financing not stated: ask");

  // Owner transition (5)
  if (l.ownerStays === "yes") add("Transition", 5, 5, "Owner will stay on");
  else if (l.ownerStays === "transition") add("Transition", box.preferOwnerStays ? 4 : 5, 5, "Training / transition period offered");
  else if (l.ownerStays === "no") add("Transition", box.preferOwnerStays ? 0 : 3, 5, "Owner leaves at close");
  else add("Transition", 2.5, 5, "Transition not stated: ask");

  // Synergy (10)
  add("Synergy", effectiveSynergy * 2, 10, l.synergyOverride != null ? `Set by hand: ${effectiveSynergy}/5` : box.synergyKeywords.length ? `${effectiveSynergy}/5 from your synergy keywords` : "No synergy keywords set");

  // Seller motivation (5): time on market and reason for selling.
  const days = daysOnline(l, now);
  const reason = (l.reasonForSelling ?? "").toLowerCase();
  const motivated = /retir|health|relocat|divorc|estate|must sell|motivated|burn/.test(reason);
  if (motivated && days >= 90) add("Motivation", 5, 5, `${days} days listed, and: ${l.reasonForSelling}`);
  else if (motivated) add("Motivation", 4, 5, `Reason for selling: ${l.reasonForSelling}`);
  else if (days >= 180) add("Motivation", 4, 5, `${days} days listed: room to negotiate`);
  else if (days >= 90) add("Motivation", 3, 5, `${days} days listed`);
  else add("Motivation", 2, 5, days <= 14 ? "Fresh listing" : `${days} days listed`);

  const total = parts.reduce((s, p) => s + p.points, 0);
  return { fitScore: Math.max(0, Math.min(100, Math.round(total))), fitBreakdown: parts, synergy };
}
