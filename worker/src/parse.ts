import type { ListingInput, OwnerRole, OwnerStays, Remote, Tri } from "./types";

/**
 * Turning listing pages, alert emails and free text into structured fields. Everything here is plain
 * string work (no DOM), so the same code handles a page clipped in the browser, a page fetched by the
 * Worker and a broker's email reply. Marketplaces label their fields consistently ("Asking Price:",
 * "Cash Flow:", "Reason for Selling:"), so the page parser is label-driven rather than tied to one
 * site's markup.
 */

// ---------- money and numbers ----------

/** "$1,250,000" | "$1.2M" | "450K" | "USD 90,000" -> dollars. Returns null for "Not disclosed", "N/A", "Call". */
export function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/ /g, " ").match(/(?:US?\$|USD|\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|mm|b|thousand|million|billion)?\b/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") n *= 1e3;
  else if (unit === "m" || unit === "mm" || unit === "million") n *= 1e6;
  else if (unit === "b" || unit === "billion") n *= 1e9;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(US_STATES));

/** "Austin, TX" | "Travis County, Texas" | "Florida" -> "TX" / "FL"; null when no US state is recognisable. */
export function parseState(location: string | null | undefined): string | null {
  if (!location) return null;
  const code = location.match(/(?:,|^)\s*([A-Z]{2})\b(?:\s+\d{5})?\s*(?:,\s*(?:USA?|United States))?\s*$/);
  if (code && STATE_CODES.has(code[1])) return code[1];
  const lower = location.toLowerCase();
  // Longest names first so "west virginia" wins over "virginia".
  for (const name of Object.keys(US_STATES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return US_STATES[name];
  }
  return null;
}

// ---------- free-text signals ----------

export interface Signals {
  sellerFinancing: Tri;
  financingNotes: string | null;
  sbaEligible: Tri;
  reasonForSelling: string | null;
  ownerRole: OwnerRole;
  ownerHours: number | null;
  ownerStays: OwnerStays;
  transitionNotes: string | null;
  remoteManageable: Remote;
  homeBased: number | null;
  franchise: number | null;
  /** Hints that the seller wants out soon (retirement, health, relocation, price cuts). */
  motivated: boolean;
}

/** The sentence around a match, trimmed, for the "notes" fields. */
function sentenceAround(text: string, index: number, max = 240): string {
  const start = Math.max(text.lastIndexOf(".", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  let end = text.length;
  for (const stop of [".", "\n"]) {
    const i = text.indexOf(stop, index);
    if (i !== -1 && i < end) end = i + (stop === "." ? 1 : 0);
  }
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, max);
}

const RE = {
  financingNo: /\b(?:(?:seller|owner) financing\s*[:\-–]\s*(?:no\b|none\b|not (?:available|offered))|no (?:seller|owner) financ\w*|not (?:offering|open to|willing to (?:offer|provide|consider)) (?:any )?(?:seller|owner)? ?financ\w*|cash (?:only|buyers? only)|all[- ]cash (?:offers?|buyers?|only))\b/i,
  financingYes: /\b(?:seller|owner)[- ](?:financing|finance|financed|carry(?:back)?|note|terms)\b|\b(?:seller|owner) (?:will|would|may|is willing to|is open to|can|could) (?:carry|finance|hold a note|consider (?:financing|terms|a note))|\bfinancing (?:is )?(?:available|offered|possible|negotiable)\b|\bopen to (?:seller |owner )?financing\b|\bterms (?:are )?(?:available|negotiable)\b|\bwill carry\b|\bearn[- ]?out (?:is )?(?:available|possible|considered)/i,
  sba: /\bSBA[- ](?:pre[- ]?qualified|pre[- ]?approved|approved|eligible|qualified|financ\w+|loan|lend\w+|7\(?a\)?)|\b(?:pre[- ]?qualified|pre[- ]?approved|qualifies|eligible) for (?:an? )?SBA\b|\blender[- ]pre[- ]?qualified\b/i,
  semi: /\bsemi[- ]?absentee\b/i,
  absentee: /\babsentee(?:[- ](?:owner|owned|run|ownership))?\b|\bpassive(?:ly)? (?:owned|ownership|investment|income)\b|\bowner (?:is )?not (?:involved|active|required)|\bruns? (?:itself|without the owner)\b|\bfully[- ]managed\b/i,
  operator: /\bowner[- ]operat\w+|\bowner works (?:full[- ]time|in the (?:business|field|shop|store|kitchen)|on[- ]site|daily)|\bhands[- ]on owner\b|\bworking owner\b|\bowner(?:'s)? (?:is )?(?:heavily|very|actively) involved\b|\bfull[- ]time owner\b/i,
  hours: /\b(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*(?:hours?|hrs?)\s*(?:per|a|each|\/)\s*(?:week|wk)\b/i,
  staysNo: /\bno (?:training|transition|support)(?: (?:is )?(?:offered|provided|available))?\b|\bowner (?:is )?(?:leaving|moving|relocating) (?:immediately|right away|out of)|\bsold as[- ]is\b/i,
  staysYes: /\b(?:owner|seller|founder)s? (?:is |are )?(?:willing|open|happy|prepared|available|would like|wants?|want|plans?|plan) to (?:stay|remain|continue)\b|\b(?:stay|remain)(?:ing)? (?:on|with the (?:business|company)|involved|in (?:a|the) )|\bretain(?:ing)? (?:a |an )?(?:minority )?(?:equity|stake|ownership|interest)\b|\broll(?:over)? equity\b|\bcontinue (?:in|as|working|with the|to (?:work|lead|run|manage))|\bconsult(?:ing)? (?:role|basis|agreement)\b|\bstay on as\b|\bsellers? (?:want|wants|would like) to stay\b/i,
  staysTransition: /\b(\d{1,3}|one|two|three|four|six|twelve)\s*(?:-\s*\d{1,3}\s*)?(?:days?|weeks?|months?|years?) (?:of )?(?:[\w-]+ ){0,2}(?:training|transition|support|hand[- ]?over|assistance)|\b(?:training|transition|support)(?: period)? (?:of|for)(?: up to)? (\d{1,3}|one|two|three|four|six|twelve)\s*(?:days?|weeks?|months?)|\bwill (?:train|provide (?:training|support|a transition))|\bprovide(?:s|d)? (?:full |complete |comprehensive )?(?:training|transition)|\btransition (?:period|assistance|support|plan)\b|\btraining (?:and|&) (?:support|transition)\b|\bhappy to (?:provide|offer) .{0,30}support\b|\bsmooth transition\b/i,
  remoteYes: /\b(?:run|runs|operate[sd]?|manage[sd]?|work(?:s|ed)?|own(?:ed)?) (?:the business )?(?:100% |fully |entirely |completely )?(?:remotely|from anywhere|from home)\b|\bremote(?:ly)?[- ](?:managed|operated|run|owned|based|friendly|business|team)\b|\b(?:fully|100%|completely|entirely) (?:remote|online|virtual)\b|\blocation[- ]independent\b|\b(?:can be )?relocat(?:able|ed anywhere)\b|\bonline business\b|\be-?commerce (?:business|brand|store)\b|\bSaaS\b|\bAmazon FBA\b|\bdrop-?ship\w*\b|\bcontent (?:site|website)\b|\bwork from anywhere\b|\bvirtual (?:business|team|office)\b/i,
  remotePartial: /\bmanager in place\b|\bmanagement (?:team )?(?:is )?in place\b|\bgeneral manager\b|\bstaff (?:runs?|handles?) (?:the )?day[- ]to[- ]day\b|\bturn-?key\b|\bhome[- ]based\b/i,
  homeYes: /\bhome[- ]based\b(?!\s*:\s*no)/i,
  homeNo: /\bhome[- ]based\s*:\s*no\b/i,
  franchiseYes: /\bfranchise(?:d)?\b(?!\s*:\s*no)(?! opportunit)/i,
  franchiseNo: /\bfranchise\s*:\s*no\b|\bnot a franchise\b|\bnon[- ]franchise\b|\bindependent(?:ly owned)?,? not a franchise\b/i,
  reason: /\b(?:reason for (?:selling|sale|the sale)|why (?:is the owner|are (?:you|they)) selling)\s*[:\-–]?\s*([^\n]{3,200})/i,
  reasonInline: /\b(?:owners?|sellers?|founders?) (?:is|are|has|have) (?:selling (?:due to|because(?: of)?|to)|retiring|relocating|moving|ready to retire|pursuing|focusing on|decided to)[^.\n]{0,160}|\bselling (?:due to|because(?: of)?)[^.\n]{3,160}|\b(?:due to|because of) (?:retirement|health|relocation|family|a move|other business)[^.\n]{0,120}/i,
  reasonCause: /\b(?:(?:is|are) retiring|retirement|health (?:reasons?|issues?|concerns?)|(?:is|are) relocating|divorce|estate sale|burn(?:ed|t)[- ]?out)\b/i,
  motivated: /\bretir\w+|\bhealth (?:reasons?|issues?|concerns?)\b|\brelocat\w+|\bdivorce\b|\bestate sale\b|\bmust sell\b|\bmotivated seller\b|\bprice(?:d)? (?:reduced|reduction|to sell|drop)\b|\bbring (?:all )?offers\b|\bburn(?:ed|t)?[- ]?out\b/i,
};

/** Read deal signals out of any text: a listing description, a full page, or a broker's reply. */
export function extractSignals(textIn: string | null | undefined): Signals {
  const text = (textIn ?? "").replace(/ /g, " ");
  const out: Signals = {
    sellerFinancing: "unknown", financingNotes: null, sbaEligible: "unknown", reasonForSelling: null,
    ownerRole: "unknown", ownerHours: null, ownerStays: "unknown", transitionNotes: null,
    remoteManageable: "unknown", homeBased: null, franchise: null, motivated: false,
  };
  if (!text.trim()) return out;

  const no = RE.financingNo.exec(text);
  const yes = RE.financingYes.exec(text);
  if (no) {
    out.sellerFinancing = "no";
    out.financingNotes = sentenceAround(text, no.index);
  } else if (yes) {
    out.sellerFinancing = "yes";
    out.financingNotes = sentenceAround(text, yes.index);
  }
  const sba = RE.sba.exec(text);
  if (sba) {
    out.sbaEligible = "yes";
    out.financingNotes ??= sentenceAround(text, sba.index);
  }

  if (RE.semi.test(text)) out.ownerRole = "semi";
  else if (RE.absentee.test(text)) out.ownerRole = "absentee";
  else if (RE.operator.test(text)) out.ownerRole = "operator";
  const h = RE.hours.exec(text);
  if (h) {
    out.ownerHours = Math.round(h[2] ? (Number(h[1]) + Number(h[2])) / 2 : Number(h[1]));
    if (out.ownerRole === "unknown") out.ownerRole = out.ownerHours <= 5 ? "absentee" : out.ownerHours <= 20 ? "semi" : "operator";
  }

  const sy = RE.staysYes.exec(text);
  const st = RE.staysTransition.exec(text);
  const sn = RE.staysNo.exec(text);
  if (sy) {
    out.ownerStays = "yes";
    out.transitionNotes = sentenceAround(text, sy.index);
  } else if (st) {
    out.ownerStays = "transition";
    out.transitionNotes = sentenceAround(text, st.index);
  } else if (sn) {
    out.ownerStays = "no";
    out.transitionNotes = sentenceAround(text, sn.index);
  }

  if (RE.remoteYes.test(text)) out.remoteManageable = "yes";
  else if (out.ownerRole === "absentee") out.remoteManageable = "yes";
  else if (RE.remotePartial.test(text) || out.ownerRole === "semi") out.remoteManageable = "partial";

  if (RE.homeNo.test(text)) out.homeBased = 0;
  else if (RE.homeYes.test(text)) out.homeBased = 1;
  if (RE.franchiseNo.test(text)) out.franchise = 0;
  else if (RE.franchiseYes.test(text)) out.franchise = 1;

  const r = RE.reason.exec(text);
  // A labelled reason is one sentence; anything after the first full stop belongs to the next thought.
  const stated = r ? r[1].split(/\.(?:\s|$)/)[0].replace(/\s+/g, " ").trim() : "";
  if (stated && !/^(?:n\/?a|not (?:disclosed|specified|provided)|-+)$/i.test(stated)) out.reasonForSelling = stated.slice(0, 200);
  else {
    const ri = RE.reasonInline.exec(text);
    const cause = ri ? null : RE.reasonCause.exec(text);
    if (ri) out.reasonForSelling = ri[0].replace(/\s+/g, " ").trim().slice(0, 200);
    else if (cause) out.reasonForSelling = sentenceAround(text, cause.index, 200).replace(/\.$/, "");
  }
  out.motivated = RE.motivated.test(`${out.reasonForSelling ?? ""} ${text}`);
  return out;
}

// ---------- labelled fields on a listing page ----------

/** A line that is only a field label, e.g. "Support & Training:". */
const LABEL_LINE = /^[A-Z][\w &,()/'+.-]{1,48}:\s*$/;

/** Value of a labelled field: the rest of the label's line, or the lines below it up to the next label. */
export function labelled(text: string, label: RegExp, maxLen = 500): string | null {
  return labelledAll(text, label, maxLen)[0] ?? null;
}

/** Every value found for a label, in page order (a page can repeat a label in a sidebar or a nav menu). */
export function labelledAll(text: string, label: RegExp, maxLen = 500): string[] {
  const lines = text.split(/\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length && found.length < 6; i++) {
    const line = lines[i].trim();
    const m = new RegExp(`^(?:${label.source})\\s*(?::|\\t| {2,}|$)\\s*(.*)$`, "i").exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (!value) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length && parts.join(" ").length < maxLen; j++) {
        const next = lines[j].trim();
        if (!next) {
          if (parts.length) break;
          continue;
        }
        if (LABEL_LINE.test(next)) break;
        parts.push(next);
        if (/^[\s$€£]*[\d.,]+\s*[kKmMbB]?$/.test(next)) break; // a bare number is the whole value
      }
      value = parts.join(" ");
    }
    value = value.replace(/\s+/g, " ").trim();
    if (value) found.push(value.slice(0, maxLen));
  }
  return found;
}

const NOT_GIVEN = /^(?:n\/?a|not (?:disclosed|specified|provided|available|applicable)|undisclosed|none|call|contact|tbd|-+|upon request)\b/i;

/**
 * A dollar figure for the first label that has one. Labels are tried in order, so the precise name
 * ("cash flow") wins over the loose one ("profit") wherever each sits on the page. Falls back to
 * "Label: $123" appearing mid-line, as on search-result cards.
 */
function money(text: string, labels: RegExp[]): number | null {
  for (const label of labels) {
    for (const v of labelledAll(text, label, 60)) {
      if (NOT_GIVEN.test(v)) continue;
      const n = /^[\s$€£A-Z]*\d/.test(v) ? parseMoney(v) : null;
      if (n !== null) return n;
    }
  }
  for (const label of labels) {
    const m = new RegExp(`\\b(?:${label.source})\\s*:?\\s*(\\$\\s?[\\d.,]+\\s*(?:[kKmMbB]|thousand|million)?)`, "i").exec(text);
    const n = m ? parseMoney(m[1]) : null;
    if (n !== null) return n;
  }
  return null;
}

export interface PagePayload {
  url: string;
  title?: string | null;
  /** document.body.innerText or equivalent: visible text, one block per line. */
  text: string;
  /** Parsed JSON-LD blocks found on the page. */
  jsonld?: unknown[];
  /** <meta> name/property -> content. */
  meta?: Record<string, string>;
  emails?: string[];
  phones?: string[];
}

/** Marketplace slug from a URL host: "www.bizbuysell.com" -> "bizbuysell". */
export function sourceFromUrl(url: string | null | undefined): string {
  if (!url) return "manual";
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    return (parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2]) ?? host;
  } catch {
    return "manual";
  }
}

/** A stable per-source id from a listing URL: the marketplace's own listing number when the URL carries one. */
export function sourceIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  const nums = path.match(/\d{4,}/g);
  if (nums) return nums[nums.length - 1];
  const q = u.searchParams.get("id") ?? u.searchParams.get("listing") ?? u.searchParams.get("listingId");
  if (q) return q.slice(0, 80);
  const slug = path.split("/").filter(Boolean).pop();
  return slug ? slug.toLowerCase().slice(0, 120) : null;
}

function findLd(blocks: unknown[] | undefined, types: string[]): Record<string, unknown> | null {
  const queue: unknown[] = [...(blocks ?? [])];
  while (queue.length) {
    const b = queue.shift();
    if (Array.isArray(b)) {
      queue.push(...b);
      continue;
    }
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const t = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
    if (t.some((x) => types.includes(x))) return o;
    if (o["@graph"]) queue.push(o["@graph"]);
    if (o.mainEntity) queue.push(o.mainEntity);
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** Parse one listing detail page into listing fields. Unknown fields are left out, never guessed. */
export function parseListingPage(p: PagePayload): ListingInput {
  const text = (p.text ?? "").replace(/\r/g, "").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n");
  const meta = p.meta ?? {};
  const ld = findLd(p.jsonld, ["Product", "Offer", "LocalBusiness", "Organization", "RealEstateListing", "Service"]);
  const offer = ld && typeof ld.offers === "object" && ld.offers ? ((Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) as Record<string, unknown>) : null;

  const rawTitle = str(ld?.name) ?? meta["og:title"] ?? p.title ?? labelled(text, /business name|listing title/) ?? "";
  // Drop the site suffix marketplaces append: "Profitable HVAC Company | BizBuySell".
  const title = rawTitle.replace(/\s+[|–—-]\s+(?:[\w.& ]{2,40})$/, "").replace(/\s+/g, " ").trim().slice(0, 200);

  const source = sourceFromUrl(p.url);
  const out: ListingInput = { title: title || "Untitled listing", url: p.url, source, sourceId: sourceIdFromUrl(p.url) ?? undefined };

  out.askingPrice = money(text, [/asking price/, /list(?:ing)? price|purchase price|sale price/, /price/]) ?? parseMoney(str(offer?.price) ?? str(ld?.price));
  out.cashFlow = money(text, [
    /cash flow(?: \(sde\))?|seller'?s discretionary (?:earnings|cash flow)(?: \(sde\))?|sde/,
    /discretionary earnings|owner'?s? benefit|adjusted (?:net )?(?:profit|income)/,
    /(?:annual |ttm |yearly )?net (?:profit|income)|annual profit|ttm profit/,
    /profit/,
  ]);
  out.revenue = money(text, [/gross revenue|annual revenue|ttm revenue|total revenue/, /gross sales|annual sales|gross income/, /revenue/, /sales/]);
  out.ebitda = money(text, [/(?:adjusted )?ebitda/]);
  out.inventory = money(text, [/inventory(?: value)?/]);
  out.ffe = money(text, [/ff&e|ff ?& ?e|furniture,? fixtures?,? (?:&|and) equipment(?: \(ff&e\))?/]);

  const est = labelled(text, /(?:year )?established|founded|year founded|in business since|established in/, 40);
  const year = est?.match(/\b(18|19|20)\d{2}\b/);
  if (year) out.established = Number(year[0]);
  const emp = labelled(text, /(?:number of |total )?employees|staff|team size/, 60);
  const empN = emp?.match(/\d{1,5}/);
  if (empN) out.employees = Number(empN[0]);

  const addr = ld && typeof ld.address === "object" && ld.address ? (ld.address as Record<string, unknown>) : null;
  const ldLocation = addr ? [str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean).join(", ") : null;
  out.location = labelled(text, /location|city|area|county/, 80) ?? (ldLocation || null);
  // Marketplaces usually print "City, ST" on its own line under the headline, with no label.
  out.location ??= /^([A-Z][A-Za-z.' -]{2,30},\s*[A-Z]{2})(?:\s*\(.*\))?\s*$/m.exec(text.slice(0, 1500))?.[1] ?? null;
  out.state = parseState(out.location);
  out.industry = labelled(text, /industry|category|business type|business category|sector|niche/, 80) ?? str(ld?.category);
  out.model = labelled(text, /monetization|business model|type/, 60);
  out.realEstate = labelled(text, /real estate|property|building(?: sf)?|lease(?: expiration)?|rent/, 120);

  const reason = labelled(text, /reason for (?:selling|sale|the sale)/, 220);
  const support = labelled(text, /support (?:&|and) training|training (?:&|and) support|training|transition|seller support/, 300);
  const financing = labelled(text, /(?:seller )?financing|terms/, 300);
  const homeBased = labelled(text, /home[- ]based/, 20);
  const franchise = labelled(text, /franchise/, 20);

  // The description: an explicit section if the page has one, else the meta description.
  const desc =
    labelled(text, /business description|description|about (?:the|this) business|overview|summary|business overview/, 4000) ??
    str(ld?.description) ??
    meta["og:description"] ??
    meta.description ??
    null;
  out.description = desc?.slice(0, 4000) ?? null;

  const s = extractSignals(text);
  // A labelled value beats a signal inferred from free text.
  const sf = financing ? extractSignals(`seller financing: ${financing}`) : null;
  out.sellerFinancing = financing && /^(?:yes|available|negotiable|possible)\b/i.test(financing) ? "yes" : financing && /^(?:no|none|not available)\b/i.test(financing) ? "no" : sf && sf.sellerFinancing !== "unknown" ? sf.sellerFinancing : s.sellerFinancing;
  out.financingNotes = financing ?? s.financingNotes;
  out.sbaEligible = s.sbaEligible;
  out.reasonForSelling = reason && !NOT_GIVEN.test(reason) ? reason : s.reasonForSelling;
  out.ownerRole = s.ownerRole;
  out.ownerHours = s.ownerHours;
  if (support && !NOT_GIVEN.test(support)) {
    const ss = extractSignals(support);
    out.ownerStays = ss.ownerStays !== "unknown" ? ss.ownerStays : /^no\b/i.test(support) ? "no" : "transition";
    out.transitionNotes = support;
  } else {
    out.ownerStays = s.ownerStays;
    out.transitionNotes = s.transitionNotes;
  }
  out.remoteManageable = s.remoteManageable;
  out.homeBased = homeBased ? (/^y/i.test(homeBased) ? 1 : /^n/i.test(homeBased) ? 0 : s.homeBased) : s.homeBased;
  out.franchise = franchise ? (/^y/i.test(franchise) ? 1 : /^n/i.test(franchise) ? 0 : s.franchise) : s.franchise;

  // "Business Listed By:" is followed by the broker's name, then usually their firm, each on its own line.
  const lines = text.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /^(?:(?:business )?listed by|listing (?:agent|broker)|presented by|broker(?:age)?|contact(?: name)?|intermediary)\s*:?\s*(.*)$/i.test(l));
  if (at !== -1) {
    const inline = lines[at].replace(/^[^:]*:?\s*/, "").trim();
    const following = lines.slice(at + 1, at + 6).filter(Boolean);
    const [name, firm] = /:/.test(lines[at]) && inline ? [inline, following[0]] : [following[0], following[1]];
    const isName = (s: string | undefined) => !!s && s.length > 2 && s.length <= 60 && !/@|\d{3}|:$/.test(s);
    if (isName(name)) {
      out.contactName = name!.replace(/\s*[,|(].*$/, "");
      if (isName(firm) && !LABEL_LINE.test(firm!) && /\b(?:brokers?|advisors?|group|associates|partners|llc|inc|realty|m&a|capital|company|co\.?|sales|network|international)\b/i.test(firm!)) out.contactCompany = firm!;
    }
  }
  const email = (p.emails ?? []).find((e) => !/noreply|no-reply|support@|privacy@|info@(?:bizbuysell|flippa|bizquest)/i.test(e));
  if (email) out.contactEmail = email.toLowerCase();
  if (p.phones?.length) out.contactPhone = p.phones[0];
  out.contactRole = "broker";

  if (/\b(?:sale pending|under contract|under offer|under loi)\b/i.test(text.slice(0, 3000))) out.status = "pending";
  if (/\b(?:this (?:listing|business) (?:has been|is) sold|no longer available|listing (?:has been )?removed)\b/i.test(text.slice(0, 3000))) out.status = "sold";

  out.rawText = text.slice(0, 200_000);
  return out;
}

// ---------- HTML helpers (server-side URL import, alert emails) ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", trade: "™", reg: "®" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Visible text of an HTML document, one block per line (a rough innerText). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|dt|dd|ul|ol|table|header|footer|main|blockquote)>/gi, "\n")
      .replace(/<\/(?:td|th)>/gi, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build the same payload the browser clipper sends, from raw HTML fetched by the Worker. */
export function pageFromHtml(url: string, html: string): PagePayload {
  const jsonld: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonld.push(JSON.parse(m[1].trim()));
    } catch {
      // Malformed JSON-LD is common; skip the block.
    }
  }
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /(?:name|property)=["']([^"']+)["']/i.exec(m[0])?.[1];
    const content = /content=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (key && content) meta[key.toLowerCase()] = decodeEntities(content);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]).toLowerCase()))];
  const phones = [...new Set([...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1].trim()))];
  return { url, title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : null, text: htmlToText(html), jsonld, meta, emails, phones };
}

// ---------- saved-search alert emails ----------

/** Senders whose mail is treated as listing alerts. The Gmail bridge searches for these domains. */
export const ALERT_DOMAINS = [
  "bizbuysell.com", "bizquest.com", "flippa.com", "businessbroker.net", "businessesforsale.com", "loopnet.com", "dealstream.com",
  "acquire.com", "empireflippers.com", "quietlight.com", "websiteclosers.com", "feinternational.com", "sunbeltnetwork.com", "tworld.com",
  "bizben.com", "globalbx.com", "motioninvest.com", "latonas.com",
];

/** URL shapes that are a single listing's page on the big marketplaces. */
export const LISTING_URL = /bizbuysell\.com\/(?:business-opportunity|business-for-sale|franchise-for-sale)\/[^/?#]+\/\d+|bizquest\.com\/(?:business-for-sale|listing)\/[^?#]*\d{4,}|flippa\.com\/\d{6,}|businessbroker\.net\/(?:business-for-sale|listings)\/[^?#]*\d{4,}|businessesforsale\.com\/[^?#]*\/[\w-]+\.aspx|loopnet\.com\/biz\/[^?#]*\d{5,}|dealstream\.com\/[^?#]*\/\d{4,}|empireflippers\.com\/listing\/\d+|acquire\.com\/(?:startup|listing)s?\/[\w-]+|quietlight\.com\/listings\/\d+|websiteclosers\.com\/businesses-for-sale\/[\w-]+/i;

const BOILERPLATE = /unsubscribe|view (?:all|more|in browser|online)|manage (?:alerts?|preferences|your)|privacy|terms of|contact us|help cent|sign in|log ?in|download (?:the|our) app|see (?:all|more)|edit (?:your )?search|click here|learn more|get started|update (?:your )?(?:preferences|profile)|advertis|facebook|twitter|linkedin|instagram/i;

export interface AlertEmail {
  from: string;
  subject: string;
  html?: string | null;
  text?: string | null;
}

/**
 * Pull listings out of a marketplace's saved-search alert email. Best effort by design: an anchor counts
 * as a listing when its link is a known listing URL, or when it reads like a headline and a price follows
 * it. Alert links are often click-tracking redirects, so the link is kept as-is (it still opens the listing).
 */
export function parseAlertEmail(e: AlertEmail): ListingInput[] {
  const domain = (e.from.match(/@([\w.-]+)/)?.[1] ?? "").toLowerCase();
  const site = ALERT_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
  if (!site) return [];
  const source = site.split(".")[0];
  const out = new Map<string, ListingInput>();

  if (e.html) {
    const html = e.html;
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(m[1]);
      const anchor = htmlToText(m[2]).replace(/\s+/g, " ").trim();
      if (!/^https?:/i.test(href) || anchor.length < 12 || anchor.length > 160 || BOILERPLATE.test(anchor)) continue;
      const direct = LISTING_URL.test(href);
      const after = htmlToText(html.slice(m.index + m[0].length, m.index + m[0].length + 1500)).slice(0, 420);
      const price = /(?:asking(?: price)?|price)\s*:?\s*(\$[\d.,]+\s*[kKmM]?)/i.exec(after) ?? /(\$\s?\d[\d.,]*\s*[kKmM]?)/.exec(after);
      if (!direct && !price) continue;
      if (!direct && /^\$?[\d.,]+\s*[kKmM]?$/.test(anchor)) continue; // the price itself is linked, not a headline
      const cash = /(?:cash flow|sde|profit|net)\s*:?\s*(\$[\d.,]+\s*[kKmM]?)/i.exec(after);
      const rev = /(?:revenue|gross|sales)\s*:?\s*(\$[\d.,]+\s*[kKmM]?)/i.exec(after);
      const loc = /\b([A-Z][A-Za-z.' -]{2,30},\s*[A-Z]{2})\b/.exec(after);
      const id = (direct ? sourceIdFromUrl(href) : null) ?? `alert-${hash(anchor.toLowerCase())}`;
      if (out.has(id)) continue;
      out.set(id, {
        source, sourceId: id, url: href, title: anchor,
        askingPrice: parseMoney(price?.[1]), cashFlow: parseMoney(cash?.[1]), revenue: parseMoney(rev?.[1]),
        location: loc?.[1] ?? null, state: parseState(loc?.[1]), tags: ["from-alert"],
      });
    }
  }
  if (!out.size && e.text) {
    // Plain-text alerts: a listing URL with the headline on the line above it.
    const lines = e.text.split(/\n/).map((l) => l.trim());
    lines.forEach((line, i) => {
      const url = line.match(/https?:\/\/\S+/)?.[0];
      if (!url || !LISTING_URL.test(url)) return;
      const title = [lines[i - 1], lines[i - 2]].find((l) => l && l.length >= 12 && l.length <= 160 && !/^https?:/.test(l) && !BOILERPLATE.test(l));
      const id = sourceIdFromUrl(url);
      if (!title || !id || out.has(id)) return;
      const near = lines.slice(i - 2, i + 4).join(" ");
      out.set(id, { source, sourceId: id, url, title, askingPrice: parseMoney(/\$[\d.,]+\s*[kKmM]?/.exec(near)?.[0]), tags: ["from-alert"] });
    });
  }
  return [...out.values()].slice(0, 60);
}

/** Small stable string hash (FNV-1a), for ids derived from text. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
