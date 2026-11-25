import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DEFAULT_NDA_TEMPLATE, buildNda, placeFields, readPdf, scanNda, type Signer } from "../worker/src/ndapdf";

const WHO: Signer = { name: "Avery Stone", title: "Managing Member", company: "Northwind Holdings LLC", email: "avery@northwind.example", phone: "555-0100", address: "1 Main St, Austin, TX" };

/** A broker-style NDA: body text, then whatever signature block the test wants, drawn line by line. */
async function brokerPdf(body: string[], block: { text: string; x?: number; y: number }[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  let y = 730;
  for (const line of body) {
    page.drawText(line, { x: 72, y, size: 10, font });
    y -= 16;
  }
  for (const b of block) page.drawText(b.text, { x: b.x ?? 72, y: b.y, size: 10, font });
  return pdf.save();
}

test("our NDA: the variables are filled in and the signature spots are on the page", async () => {
  const { bytes, fields, pages } = await buildNda({ template: DEFAULT_NDA_TEMPLATE, buyer: "Avery Stone, Northwind Holdings LLC", buyerTitle: "Managing Member", buyerAddress: "", buyerEmail: "avery@northwind.example", business: "$61.2K Per Month SaaS Business (empireflippers listing 89701)", counterparty: "Jordan Reyes, Coastal Brokers", termYears: 2, state: "the State of Texas" });
  const read = await readPdf(bytes);
  assert.equal(read.pages.length, pages);
  assert.match(read.text, /CONFIDENTIALITY AGREEMENT/);
  assert.match(read.text, /Avery Stone, Northwind Holdings LLC/);
  assert.match(read.text.replace(/\s+/g, " "), /empireflippers listing 89701/);
  assert.match(read.text, /last for 2 years/);
  assert.doesNotMatch(read.text, /\{\{/);
  assert.deepEqual(fields.map((f) => f.type), ["SIGNATURE", "DATE"]);
  // Each field sits right of its own label, on the same page.
  const sig = read.lines.find((l) => l.text.startsWith("Signature:"))!;
  const f = fields[0];
  assert.equal(f.page, sig.page);
  assert.ok(f.positionX > (sig.x / 612) * 100, "signature field starts right of its label");
  const fieldMid = f.positionY + f.height / 2;
  const labelMid = ((sig.top + sig.h / 2) / 792) * 100;
  assert.ok(Math.abs(fieldMid - labelMid) < 3.5, `signature field is level with its label (${fieldMid} vs ${labelMid})`);
  for (const x of fields) assert.ok(x.positionX + x.width <= 100 && x.positionY + x.height <= 100);
});

test("our NDA: odd characters in a listing title don't break the PDF", async () => {
  const { bytes } = await buildNda({ template: "For {{business}} with {{counterparty}}.", buyer: "Avery Stone", buyerTitle: "", buyerAddress: "", buyerEmail: "", business: "Café “München” — 日本 🚀 SaaS", counterparty: "", termYears: 2, state: "" });
  assert.match((await readPdf(bytes)).text, /Caf. "M.nchen" - /);
});

test("their NDA: one signature block, labels then rules", async () => {
  const pdf = await brokerPdf(
    ["NON-DISCLOSURE AGREEMENT", "The undersigned prospective buyer agrees to keep all information confidential", "for a period of two (2) years."],
    [
      { text: "Buyer Signature: ______________________________", y: 300 },
      { text: "Print Name: ______________________________", y: 270 },
      { text: "Date: ______________", y: 240 },
      { text: "Email: ______________________________", y: 210 },
    ],
  );
  const { fields, placement } = placeFields(await readPdf(pdf), WHO);
  assert.equal(placement, "anchored");
  assert.deepEqual(fields.map((f) => f.type).sort(), ["DATE", "SIGNATURE", "TEXT", "TEXT"]);
  const sig = fields.find((f) => f.type === "SIGNATURE")!;
  // The label is drawn at y=300 from the bottom: ~62% down the page. The field sits on that line, right of the label.
  assert.ok(Math.abs(sig.positionY + sig.height / 2 - 62) < 4, `signature field level with its line (${sig.positionY})`);
  assert.ok(sig.positionX > 20, "signature field starts after the label");
  assert.deepEqual(fields.filter((f) => f.type === "TEXT").map((f) => f.text).sort(), ["Avery Stone", "avery@northwind.example"]);
});

test("their NDA: two parties side by side, the buyer's block is chosen", async () => {
  const pdf = await brokerPdf(
    ["CONFIDENTIALITY AGREEMENT", "Agreed and accepted:"],
    [
      { text: "BROKER", x: 72, y: 330 },
      { text: "By: ____________________", x: 72, y: 300 },
      { text: "Name: ____________________", x: 72, y: 275 },
      { text: "PROSPECTIVE PURCHASER", x: 340, y: 330 },
      { text: "By: ____________________", x: 340, y: 300 },
      { text: "Name: ____________________", x: 340, y: 275 },
      { text: "Title: ____________________", x: 340, y: 250 },
    ],
  );
  const { fields, placement } = placeFields(await readPdf(pdf), WHO);
  assert.equal(placement, "anchored");
  for (const f of fields) assert.ok(f.positionX > 50, `every field is in the right-hand (buyer) column: ${f.type} at ${f.positionX}`);
  assert.deepEqual(fields.filter((f) => f.type === "TEXT").map((f) => f.text).sort(), ["Avery Stone", "Managing Member"]);
});

test("their NDA: rule above, label below", async () => {
  const pdf = await brokerPdf(
    ["NDA", "The Recipient agrees to hold the information in confidence."],
    [
      { text: "______________________________", y: 300 },
      { text: "Signature of Buyer", y: 286 },
    ],
  );
  const { fields, placement } = placeFields(await readPdf(pdf), WHO);
  assert.equal(placement, "anchored");
  const sig = fields[0];
  assert.equal(sig.type, "SIGNATURE");
  // The rule is at y=300 from the bottom (62% down); the signature sits on it, above the label.
  assert.ok(sig.positionY + sig.height <= 64.5 && sig.positionY > 54, `signature sits on the rule (${sig.positionY}..${sig.positionY + sig.height})`);
});

test("their NDA: two unlabelled signature lines is a guess, none is a fallback", async () => {
  const two = await brokerPdf(["NDA"], [{ text: "Signature: ____________________", y: 300 }, { text: "Signature: ____________________", y: 200 }]);
  assert.equal(placeFields(await readPdf(two), WHO).placement, "guess");
  const none = await brokerPdf(["NDA", "By reading this document you agree to keep it confidential."], []);
  const r = placeFields(await readPdf(none), WHO);
  assert.equal(r.placement, "fallback");
  assert.equal(r.fields[0].type, "SIGNATURE");
  assert.ok(r.fields[0].positionY > 70, "fallback fields sit at the foot of the last page");
});

test("their NDA: prose that starts with a label word is not a blank to fill", async () => {
  const pdf = await brokerPdf(["Date of this Agreement is the date first written above by the parties.", "By signing below the buyer accepts every term of this agreement in full."], [{ text: "Signature: ____________________", y: 300 }]);
  const { fields } = placeFields(await readPdf(pdf), WHO);
  assert.deepEqual(fields.map((f) => f.type), ["SIGNATURE"]);
});

test("clause scan: a plain NDA raises nothing red", () => {
  const flags = scanNda("The undersigned agrees to keep confidential all information about the business and to use it only to evaluate a purchase. The undersigned will not contact employees, customers or suppliers without the broker's consent. These obligations continue for a period of two (2) years. ".repeat(2));
  assert.deepEqual(flags.filter((f) => f.level === "red"), []);
});

test("clause scan: the clauses that cost money are red, with the sentence quoted", () => {
  const text =
    "Buyer acknowledges that Broker is the procuring cause. If Buyer purchases the business other than through Broker, Buyer shall pay Broker a commission equal to ten percent of the purchase price. " +
    "Buyer agrees to indemnify and hold Broker harmless from any claim. Buyer shall not engage in any competing business within 50 miles. " +
    "Buyer shall not solicit or hire any employee of the business. Breach entitles Seller to liquidated damages of $50,000. These obligations survive indefinitely.";
  const flags = scanNda(text);
  const red = flags.filter((f) => f.level === "red").map((f) => f.label);
  for (const want of ["You may owe the broker a fee or commission", "Indemnity", "Non-compete", "Fixed or liquidated damages", "No end date"]) assert.ok(red.includes(want), `missing red flag: ${want} (got ${red.join("; ")})`);
  assert.ok(flags.some((f) => f.level === "amber" && /Non-solicitation/.test(f.label)));
  assert.match(flags.find((f) => /commission/.test(f.label))!.quote, /shall pay Broker a commission/);
});

test("clause scan: long terms and missing terms are noted; a scan is refused", () => {
  assert.ok(scanNda(`${"The recipient keeps the information confidential. ".repeat(12)} This lasts for a period of five (5) years.`).some((f) => f.label === "Lasts 5 years"));
  assert.ok(scanNda("The recipient keeps the information confidential and uses it only to evaluate the business. ".repeat(8)).some((f) => f.label === "No stated term"));
  assert.ok(scanNda("").some((f) => f.level === "red" && /Could not read/.test(f.label)));
});
