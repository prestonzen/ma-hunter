import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import type { NdaField, NdaFlag, NdaPlacement } from "./types";

/**
 * The PDF side of NDA signing, with no network and no database:
 *
 *   buildNda     our own one-way confidentiality agreement as a PDF, with the signature spots known exactly.
 *   readPdf      a broker's NDA: its text, line by line, with where each line sits on the page.
 *   scanNda      clauses worth a second look before signing (fees, non-solicits, long terms ...).
 *   placeFields  where the buyer signs a broker's NDA, found from its "Signature:" / "Name:" / "Date:" labels.
 *
 * Positions handed to Documenso are percentages of the page, measured from the top-left corner.
 */

// ---------- our NDA ----------

export const DEFAULT_NDA_TEMPLATE = `This Confidentiality Agreement is given by {{buyer}} ("Recipient") for the benefit of the owner of the business described as {{business}} (the "Business") and its representative {{counterparty}} (together, the "Disclosing Party").

1. Purpose. Recipient is evaluating a possible acquisition of the Business (the "Transaction") and has asked for information about it.

2. Confidential Information. "Confidential Information" means all non-public information about the Business that the Disclosing Party provides to Recipient, including its identity, financial statements, customers, suppliers, employees, pricing and operations, and the fact that the Business is for sale. It does not include information that is or becomes public other than through Recipient, that Recipient already knew or independently developed, or that Recipient lawfully receives from a third party free of any duty of confidence.

3. Use and protection. Recipient will use Confidential Information only to evaluate the Transaction, will protect it with reasonable care, and will not disclose it to anyone except Recipient's advisers, lenders and partners who need it for that evaluation and who are bound to keep it confidential. Recipient is responsible for their compliance.

4. No contact. Recipient will not contact the Business's employees, customers, suppliers or landlord about the Transaction without the Disclosing Party's consent.

5. Required disclosure. If Recipient is required by law to disclose Confidential Information, it will, where lawful, tell the Disclosing Party first and disclose only what is required.

6. Return. On request, Recipient will return or destroy the Confidential Information, except copies it must keep by law or under ordinary backup procedures, which stay subject to this Agreement.

7. No obligation, no warranty. Nothing here obliges either side to proceed with a Transaction. The Disclosing Party makes no warranty about the Confidential Information except as set out in a signed purchase agreement.

8. Term. Recipient's obligations last for {{term_years}} years from the date below.

9. General. This Agreement is the whole agreement about its subject, may be changed only in writing, and is governed by the laws of {{state}}. A signature delivered electronically is as effective as an original.`;

const PAGE = { w: 612, h: 792, margin: 64 };

/** Standard PDF fonts only cover WinAnsi; anything else would throw while drawing. */
const winAnsi = (s: string) =>
  s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, "?");

export interface OurNdaInput {
  template: string;
  buyer: string;
  buyerTitle: string;
  buyerAddress: string;
  buyerEmail: string;
  business: string;
  counterparty: string;
  termYears: number;
  state: string;
}

export async function buildNda(a: OurNdaInput): Promise<{ bytes: Uint8Array; fields: NdaField[]; pages: number }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const size = 10.5;
  const lead = 15;
  const width = PAGE.w - PAGE.margin * 2;
  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;

  const need = (h: number) => {
    if (y - h < PAGE.margin) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
    }
  };
  const wrap = (text: string, f = font, s = size): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, s) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const para = (text: string, f = font, s = size, gap = 8) => {
    for (const line of wrap(text, f, s)) {
      need(lead);
      page.drawText(line, { x: PAGE.margin, y: y - s, size: s, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= lead;
    }
    y -= gap;
  };

  const vars: Record<string, string> = {
    buyer: a.buyer,
    business: a.business,
    counterparty: a.counterparty || "the Business's broker or owner",
    term_years: String(a.termYears),
    state: a.state || "the state in which the Business is located",
  };
  const body = winAnsi(a.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? ""));

  para("CONFIDENTIALITY AGREEMENT", bold, 14, 10);
  for (const block of body.split(/\n\s*\n/)) para(block.replace(/\s*\n\s*/g, " ").trim());

  // The signature block stays together on one page.
  need(150);
  y -= 6;
  para("RECIPIENT", bold, size, 16);
  const labelX = PAGE.margin;
  const valueX = PAGE.margin + 70;
  const fields: NdaField[] = [];
  const pageIndex = pdf.getPageCount();
  const pct = (xPt: number, topPt: number, wPt: number, hPt: number) => ({
    page: pageIndex,
    positionX: +((xPt / PAGE.w) * 100).toFixed(2),
    positionY: +((topPt / PAGE.h) * 100).toFixed(2),
    width: +((wPt / PAGE.w) * 100).toFixed(2),
    height: +((hPt / PAGE.h) * 100).toFixed(2),
  });
  const row = (label: string, value: string | null, kind?: "SIGNATURE" | "DATE") => {
    const rowH = kind === "SIGNATURE" ? 40 : 22;
    const base = y - rowH + 6;
    page.drawText(label, { x: labelX, y: base, size, font, color: rgb(0.1, 0.1, 0.1) });
    if (value) page.drawText(winAnsi(value).slice(0, 80), { x: valueX, y: base, size, font, color: rgb(0.1, 0.1, 0.1) });
    else page.drawLine({ start: { x: valueX, y: base - 2 }, end: { x: valueX + 230, y: base - 2 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
    if (kind) fields.push({ type: kind, ...pct(valueX, PAGE.h - (y - 2), kind === "SIGNATURE" ? 200 : 130, rowH - 6) });
    y -= rowH;
  };
  row("Signature:", null, "SIGNATURE");
  row("Name:", a.buyer);
  if (a.buyerTitle) row("Title:", a.buyerTitle);
  if (a.buyerAddress) row("Address:", a.buyerAddress);
  if (a.buyerEmail) row("Email:", a.buyerEmail);
  row("Date:", null, "DATE");

  return { bytes: await pdf.save(), fields, pages: pdf.getPageCount() };
}

// ---------- reading a broker's NDA ----------

export interface PdfLine {
  page: number;
  /** Points from the left edge, and from the TOP of the page to the top of the text. */
  x: number;
  top: number;
  w: number;
  h: number;
  text: string;
}

export interface PdfRead {
  pages: { width: number; height: number }[];
  lines: PdfLine[];
  text: string;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export async function readPdf(bytes: ArrayBuffer | Uint8Array): Promise<PdfRead> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice());
  const pages: PdfRead["pages"] = [];
  const lines: PdfLine[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 30); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height });
    const content = await page.getTextContent();
    const items = (content.items as unknown as TextItem[]).filter((i) => typeof i.str === "string" && i.str.trim());
    // Group text runs into lines: same baseline, to within a few points.
    const rows: { y: number; items: TextItem[] }[] = [];
    for (const it of items) {
      const y = it.transform[5];
      const r = rows.find((q) => Math.abs(q.y - y) < 3);
      if (r) r.items.push(it);
      else rows.push({ y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      // A wide gap on one baseline is two columns (two signature blocks side by side): keep them apart.
      let cur: TextItem[] = [];
      const flush = () => {
        if (!cur.length) return;
        const x = cur[0].transform[4];
        const last = cur[cur.length - 1];
        const h = Math.max(...cur.map((i) => i.height || Math.abs(i.transform[3]) || 10));
        lines.push({ page: n, x, top: vp.height - r.y - h, w: last.transform[4] + last.width - x, h, text: cur.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim() });
        cur = [];
      };
      for (const it of r.items) {
        const prev = cur[cur.length - 1];
        if (prev && it.transform[4] - (prev.transform[4] + prev.width) > 60) flush();
        cur.push(it);
      }
      flush();
    }
  }
  return { pages, lines, text: lines.map((l) => l.text).join("\n") };
}

// ---------- clause scan ----------

const RED: [RegExp, string][] = [
  [/\b(?:commission|broker(?:'s|age)? fee|success fee|finder'?s fee)\b[^.]{0,160}\b(?:buyer|purchaser|recipient|undersigned|prospective)\b[^.]{0,80}\b(?:pay|liable|responsible|owe)|\b(?:buyer|purchaser|recipient|undersigned)\b[^.]{0,120}\b(?:shall|will|agrees? to)\s+(?:pay|be (?:liable|responsible) for)[^.]{0,80}\b(?:commission|fee)\b/i, "You may owe the broker a fee or commission"],
  [/\bliquidated damages\b|\bpenalty of \$|\$\s?[\d,]{4,}[^.]{0,60}\b(?:per (?:breach|violation|day)|as damages)\b/i, "Fixed or liquidated damages"],
  [/\bnon[- ]?compet|\bshall not (?:directly or indirectly )?(?:compete|engage in (?:any|a) (?:similar|competing))|\bnot to compete\b/i, "Non-compete"],
  [/\bexclusiv(?:e|ity)\b[^.]{0,100}\b(?:deal|negotiat|represent|broker|agent)|\bsole(?:ly)? (?:and exclusive )?(?:agent|broker)\b/i, "Exclusivity or exclusive agency"],
  [/\bindemnif(?:y|ies|ication)\b|\bhold\b[^.]{0,30}\bharmless\b/i, "Indemnity"],
  [/\bpersonal(?:ly)? guarant|\bjointly and severally\b/i, "Personal guarantee or joint liability"],
  [/\b(?:perpetual|in perpetuity|indefinitely|survive[sd]? (?:forever|indefinitely)|without (?:limit|limitation) (?:as to|of) time)\b/i, "No end date"],
  [/\b(?:deposit|earnest money|retainer|upfront fee|non-?refundable)\b/i, "Money asked for up front"],
  [/\bpower of attorney\b|\bconfess(?:ion of)? judgment\b|\bwaive[sd]?\b[^.]{0,40}\b(?:jury|right to (?:a )?trial)\b/i, "Waiver of legal rights"],
];

const AMBER: [RegExp, string][] = [
  [/\bnon[- ]?solicit|\bshall not\b[^.]{0,60}\b(?:solicit|hire|employ)\b|\bnot (?:to )?(?:solicit|hire)\b/i, "Non-solicitation of staff or customers"],
  [/\bnon[- ]?circumvent|\bcircumvent\b|\bdirectly (?:with|to) the (?:seller|owner)\b[^.]{0,80}\b(?:without|except through)\b/i, "Non-circumvention: all contact goes through the broker"],
  [/\binjunct(?:ive|ion)\b|\bequitable relief\b|\bspecific performance\b/i, "Injunctive relief"],
  [/\battorneys?'? fees\b|\blegal fees\b|\bcosts of enforcement\b/i, "You pay legal fees if you lose a dispute"],
  [/\b(?:financial statement|proof of funds|net worth|credit (?:report|check)|social security|background check)\b/i, "Asks for your financial or personal details"],
  [/\b(?:dual agen|represents? the seller|agent (?:of|for) the seller|does not represent (?:the )?buyer)\b/i, "Broker represents the seller only"],
  [/\barbitrat/i, "Arbitration clause"],
];

const YEARS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };

/** Clauses a buyer should read before signing. A heuristic, not legal advice: it finds, it doesn't judge. */
export function scanNda(text: string): NdaFlag[] {
  const flat = text.replace(/\s+/g, " ");
  const flags: NdaFlag[] = [];
  const quote = (m: RegExpExecArray) => {
    const start = Math.max(0, flat.lastIndexOf(".", m.index) + 1);
    const end = flat.indexOf(".", m.index + m[0].length);
    return flat.slice(start, end < 0 ? start + 240 : Math.min(end + 1, start + 320)).trim();
  };
  for (const [level, set] of [["red", RED], ["amber", AMBER]] as const) {
    for (const [re, label] of set) {
      const m = re.exec(flat);
      if (m) flags.push({ level, label, quote: quote(m) });
    }
  }
  // Term: a stated number of years. Over three is worth a look; no stated term at all is too.
  const term = /\b(?:period|term) of (?:\(?(\d{1,2})\)?|(one|two|three|four|five|six|seven|ten))(?: \(\d{1,2}\))? ?years?\b|\bfor (?:\(?(\d{1,2})\)?|(one|two|three|four|five|six|seven|ten))(?: \(\d{1,2}\))? ?years?\b/i.exec(flat);
  if (term) {
    const n = Number(term[1] ?? term[3]) || YEARS[(term[2] ?? term[4] ?? "").toLowerCase()] || 0;
    if (n > 3) flags.push({ level: "amber", label: `Lasts ${n} years`, quote: quote(term) });
  } else if (flat.length > 400 && !flags.some((f) => f.label === "No end date")) {
    flags.push({ level: "amber", label: "No stated term", quote: "The agreement does not say how long the obligations last." });
  }
  if (flat.length < 200) flags.push({ level: "red", label: "Could not read the document's text", quote: "This PDF looks scanned. Read it yourself before signing." });
  return flags;
}

// ---------- where the buyer signs ----------

const LABELS: [NdaField["type"] | "NAME_TEXT" | "TITLE" | "COMPANY" | "EMAIL_TEXT" | "PHONE" | "ADDRESS", RegExp][] = [
  ["SIGNATURE", /^(?:(?:buyer|purchaser|recipient|prospective (?:buyer|purchaser)|authorized)(?:'s)? )?(?:signature|signed|sign here|by)\b/i],
  ["NAME_TEXT", /^(?:print(?:ed)? ?(?:name)?|(?:buyer|purchaser|full|legal)(?:'s)? name|name)\b/i],
  ["DATE", /^(?:date|dated)\b/i],
  ["TITLE", /^title\b/i],
  ["COMPANY", /^(?:company|entity|firm|organization)(?: name)?\b/i],
  ["EMAIL_TEXT", /^e-?mail(?: address)?\b/i],
  ["PHONE", /^(?:phone|telephone|tel|cell|mobile)(?: number| no\.?)?\b/i],
  ["ADDRESS", /^(?:street |mailing |home |business )?address\b/i],
];

const BUYER_SIDE = /\b(?:buyer|purchaser|prospective|recipient|receiving party|undersigned|interested party|investor|acquir)/i;
const OTHER_SIDE = /\b(?:seller|broker|disclos|owner|agent|intermediar|listing|company representative)/i;

export interface Signer {
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  address: string;
}

interface Anchor {
  kind: (typeof LABELS)[number][0];
  line: PdfLine;
  /** Where the answer goes: right of the label, on the rule if there is one. */
  x: number;
  top: number;
  w: number;
  h: number;
}

function anchors(read: PdfRead): Anchor[] {
  const out: Anchor[] = [];
  for (const line of read.lines) {
    const bare = line.text.replace(/^[\s_.\-–—:]+/, "");
    const hit = LABELS.find(([, re]) => re.test(bare));
    if (!hit) continue;
    // A label is short. "Date of this agreement is the date first written above" is prose, not a blank to fill.
    const words = bare.replace(/[_:.\-–—]+/g, " ").trim().split(/\s+/);
    if (words.length > 4) continue;
    const page = read.pages[line.page - 1];
    const labelFirst = !/^[_\s]{4,}/.test(line.text);
    const rule = /_{4,}/.exec(line.text);
    // Label then rule on one line ("Signature: ________"): the answer starts where the rule starts.
    // Rule above, label below ("________" / "Signature"): the answer sits on the line above the label.
    const above = read.lines.find((l) => l.page === line.page && /^[_\s]{6,}$/.test(l.text) && line.top - l.top > 2 && line.top - l.top < 26 && Math.abs(l.x - line.x) < 40);
    let x: number, top: number, w: number;
    if (rule && labelFirst) {
      const frac = rule.index / Math.max(1, line.text.length);
      x = line.x + line.w * frac + 2;
      w = Math.min(line.w * (rule[0].length / line.text.length), 240);
      top = line.top - 8;
    } else if (above) {
      x = above.x + 2;
      w = Math.min(Math.max(above.w, 120), 240);
      top = above.top - 14;
    } else {
      x = line.x + line.w + 6;
      w = Math.min(200, page.width - x - 36);
      top = line.top - 8;
    }
    if (w < 60) continue;
    out.push({ kind: hit[0], line, x, top: Math.max(0, top), w, h: hit[0] === "SIGNATURE" ? 30 : 18 });
  }
  return out;
}

/** Which party a signature label belongs to: the nearest heading above it in the same column says. */
function sideOf(read: PdfRead, a: Anchor): "buyer" | "other" | "unknown" {
  if (BUYER_SIDE.test(a.line.text)) return "buyer";
  if (OTHER_SIDE.test(a.line.text)) return "other";
  const above = read.lines
    .filter((l) => l.page === a.line.page && l.top < a.line.top && a.line.top - l.top < 150 && Math.abs(l.x - a.line.x) < 120 && l.text.length < 60)
    .sort((p, q) => q.top - p.top);
  for (const l of above) {
    if (BUYER_SIDE.test(l.text)) return "buyer";
    if (OTHER_SIDE.test(l.text)) return "other";
  }
  return "unknown";
}

/**
 * Fields for the buyer on someone else's NDA. "anchored": one signature block is clearly the buyer's.
 * "guess": there is a signature line, but which party it belongs to isn't certain. "fallback": no
 * signature line could be found, so the fields sit at the foot of the last page for a person to move.
 */
export function placeFields(read: PdfRead, who: Signer): { fields: NdaField[]; placement: NdaPlacement } {
  const all = anchors(read);
  const sigs = all.filter((a) => a.kind === "SIGNATURE").map((a) => ({ a, side: sideOf(read, a) }));
  const buyers = sigs.filter((s) => s.side === "buyer");
  const unknown = sigs.filter((s) => s.side === "unknown");
  const lastPage = read.pages.length || 1;

  let chosen: Anchor | null = null;
  let placement: NdaPlacement = "fallback";
  if (buyers.length === 1) [chosen, placement] = [buyers[0].a, "anchored"];
  else if (!buyers.length && unknown.length === 1 && sigs.length === 1) [chosen, placement] = [unknown[0].a, "anchored"];
  else if (buyers.length > 1) [chosen, placement] = [buyers[buyers.length - 1].a, "guess"];
  else if (unknown.length) [chosen, placement] = [unknown[unknown.length - 1].a, "guess"];

  const toField = (type: NdaField["type"], a: { line: { page: number }; x: number; top: number; w: number; h: number }, text?: string): NdaField => {
    const p = read.pages[a.line.page - 1] ?? { width: PAGE.w, height: PAGE.h };
    return {
      type,
      page: a.line.page,
      positionX: +Math.min(96, (a.x / p.width) * 100).toFixed(2),
      positionY: +Math.min(96, (a.top / p.height) * 100).toFixed(2),
      width: +Math.max(8, Math.min(100 - (a.x / p.width) * 100 - 2, (a.w / p.width) * 100)).toFixed(2),
      height: +((a.h / p.height) * 100).toFixed(2),
      ...(text === undefined ? {} : { text }),
    };
  };

  if (!chosen) {
    const p = read.pages[lastPage - 1] ?? { width: PAGE.w, height: PAGE.h };
    const at = (top: number, w: number, h: number) => ({ line: { page: lastPage }, x: 72, top: p.height - top, w, h });
    return {
      placement: "fallback",
      fields: [toField("SIGNATURE", at(130, 200, 30)), toField("TEXT", at(92, 220, 18), who.name), toField("DATE", at(68, 130, 18))],
    };
  }

  const fields: NdaField[] = [toField("SIGNATURE", chosen)];
  const values: Record<string, string> = { NAME_TEXT: who.name, TITLE: who.title, COMPANY: who.company, EMAIL_TEXT: who.email, PHONE: who.phone, ADDRESS: who.address };
  // The rest of the buyer's block: labels close to the chosen signature line, in the same column.
  const block = all.filter((a) => a !== chosen && a.kind !== "SIGNATURE" && a.line.page === chosen!.line.page && Math.abs(a.line.top - chosen!.line.top) < 170 && Math.abs(a.line.x - chosen!.line.x) < 150);
  const seen = new Set<string>();
  for (const a of block.sort((p, q) => Math.abs(p.line.top - chosen!.line.top) - Math.abs(q.line.top - chosen!.line.top))) {
    if (seen.has(a.kind)) continue;
    seen.add(a.kind);
    if (a.kind === "DATE") fields.push(toField("DATE", a));
    else if (values[a.kind]) fields.push(toField("TEXT", a, values[a.kind]));
  }
  return { fields, placement };
}
