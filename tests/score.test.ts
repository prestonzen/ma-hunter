import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuyBox, Listing } from "../shared/types";
import { hydrate, normalise } from "../worker/src/listings";
import { DEFAULT_OUTREACH, classifyReply, inWindow, questionsFor, render, templateVars } from "../worker/src/outreach";
import { DEFAULT_BUY_BOX, computeFit, computeSynergy, multipleOf } from "../worker/src/score";

const NOW = Date.UTC(2026, 10, 25);
const DAY = 86_400_000;

function listing(over: Partial<Listing> = {}): Listing {
  return hydrate(
    {
      id: 1, source: "bizbuysell", sourceId: "2291847", url: "https://x.example/1", title: "Commercial Landscape Maintenance Company", description: "Recurring contracts.",
      industry: "Landscaping", model: "Service", location: "Raleigh, NC", state: "NC", country: null, askingPrice: 1_200_000, revenue: 2_000_000, cashFlow: 400_000, ebitda: null,
      listedAt: NOW - 30 * DAY, firstSeen: NOW - 10 * DAY, lastSeen: NOW, sellerFinancing: "yes", sbaEligible: "unknown", reasonForSelling: null, ownerRole: "semi", ownerHours: 10,
      ownerStays: "transition", remoteManageable: "partial", synergy: 0, synergyOverride: null, fitScore: 0, fitBreakdown: "[]", stage: "new", tags: "[]", locked: "[]",
      ...over,
    } as unknown as Record<string, unknown>,
    NOW,
  );
}

const BOX: BuyBox = {
  ...DEFAULT_BUY_BOX, priceMin: 300_000, priceMax: 2_000_000, cashFlowMin: 150_000, multipleMax: 4,
  industriesInclude: ["Landscaping"], industriesExclude: ["Restaurant"], keywordsExclude: ["vape"], locations: ["NC"], synergyKeywords: ["landscap", "lawn", "irrigation"],
};

test("multiple and days online", () => {
  assert.equal(multipleOf(listing()), 3);
  assert.equal(multipleOf(listing({ cashFlow: null })), null);
  assert.equal(listing().daysOnline, 30);
  assert.equal(listing({ listedAt: null }).daysOnline, 10);
});

test("a listing inside the buy box scores high, with a readable breakdown", () => {
  const f = computeFit(listing(), BOX, NOW);
  assert.ok(f.fitScore >= 85, `expected a strong fit, got ${f.fitScore}`);
  assert.equal(f.fitBreakdown.reduce((s, p) => s + p.max, 0), 100);
  assert.ok(f.fitBreakdown.every((p) => p.points <= p.max && p.note.length > 0));
});

test("an excluded industry or keyword zeroes the score", () => {
  assert.equal(computeFit(listing({ industry: "Restaurant", title: "Sandwich shop" }), BOX, NOW).fitScore, 0);
  assert.equal(computeFit(listing({ description: "Two vape stores" }), BOX, NOW).fitScore, 0);
});

test("unknown fields score mid-way, bad ones score low", () => {
  const sparse = computeFit(listing({ askingPrice: null, cashFlow: null, sellerFinancing: "unknown", ownerStays: "unknown", remoteManageable: "unknown", state: null, location: null }), BOX, NOW).fitScore;
  const bad = computeFit(
    listing({ askingPrice: 5_000_000, cashFlow: 50_000, sellerFinancing: "no", ownerStays: "no", remoteManageable: "no", state: "CA", location: "Fresno, CA", industry: "Dry cleaning", title: "Dry cleaner", description: "" }),
    BOX,
    NOW,
  ).fitScore;
  const good = computeFit(listing(), BOX, NOW).fitScore;
  assert.ok(good > sparse && sparse > bad, `${good} > ${sparse} > ${bad}`);
});

test("synergy counts keyword hits and a hand override wins", () => {
  assert.equal(computeSynergy(listing(), BOX), 3);
  assert.equal(computeSynergy(listing({ title: "Lawn care and irrigation", description: "Landscaping too" }), BOX), 5);
  assert.equal(computeSynergy(listing({ title: "Car wash", industry: "Car Wash", description: "" }), BOX), 0);
  const byHand = computeFit(listing({ synergyOverride: 5 }), BOX, NOW).fitBreakdown.find((p) => p.label === "Synergy")!;
  assert.equal(byHand.points, 10);
});

test("a long time on the market or a pressing reason raises motivation", () => {
  const m = (over: Partial<Listing>) => computeFit(listing(over), BOX, NOW).fitBreakdown.find((p) => p.label === "Motivation")!.points;
  assert.ok(m({ listedAt: NOW - 200 * DAY }) > m({ listedAt: NOW - 5 * DAY }));
  assert.equal(m({ listedAt: NOW - 120 * DAY, reasonForSelling: "Retirement" }), 5);
});

test("normalise derives source and id, and fills signals from the description", () => {
  const n = normalise({
    title: "  Pool   Route ",
    url: "https://www.bizquest.com/business-for-sale/pool-route/BW2284519/",
    description: "Seller financing available. Absentee owner.",
    location: "Phoenix, Arizona",
    askingPrice: 540000,
  });
  assert.equal(n.source, "bizquest");
  assert.equal(n.sourceId, "2284519");
  assert.equal(n.data.title, "Pool Route");
  assert.equal(n.data.sellerFinancing, "yes");
  assert.equal(n.data.ownerRole, "absentee");
  assert.equal(n.data.state, "AZ");
  assert.equal(normalise({ title: "Shopify store", source: "flippa", sourceId: "1" }).data.remoteManageable, "yes");
  assert.throws(() => normalise({ title: "  " }));
});

test("outreach questions ask only for what the listing leaves open", () => {
  const all = questionsFor(listing({ sellerFinancing: "unknown", reasonForSelling: null, ownerStays: "unknown", remoteManageable: "unknown" }));
  assert.equal(all.length, 4);
  assert.match(all[0], /financing/);
  const few = questionsFor(listing({ reasonForSelling: "Retirement", employees: 12 }));
  assert.ok(!few.some((q) => /financing|Why is the owner/.test(q)));
});

test("templates render with listing and buyer details", () => {
  const vars = templateVars(listing(), { name: "Dana Whitfield, CBI", company: "Carolina Business Advisors" }, { ...DEFAULT_OUTREACH, myName: "Alex Morgan", myCompany: "Morgan Holdings" }, BOX);
  const out = render("Hi {{first_name}},\n\nAbout {{business}}{{ref_suffix}}{{price_clause}}.\n\n\n\n{{unknown_var}}{{signature}}", vars);
  assert.equal(out, 'Hi Dana,\n\nAbout "Commercial Landscape Maintenance Company" (listing #2291847) (asking $1.2M).\n\nAlex Morgan\nMorgan Holdings');
  assert.equal(templateVars(null, { name: "COASTAL BROKERS", company: null }, DEFAULT_OUTREACH, BOX).first_name, "there");
  assert.match(vars.buy_box, /Landscaping/);
});

test("replies are classified well enough to route", () => {
  assert.equal(classifyReply("Re: Inquiry", "Thanks for reaching out. Please sign the attached NDA and I'll send the CIM."), "nda");
  assert.equal(classifyReply("Re: Inquiry", "Unfortunately this one is under contract."), "sold");
  assert.equal(classifyReply("Automatic reply: Inquiry", "I am out of the office until Monday."), "auto_reply");
  assert.equal(classifyReply("Re: Inquiry", "Can you send proof of funds and a buyer profile?"), "proof_of_funds");
  assert.equal(classifyReply("Re: Inquiry", "Happy to talk. Are you available Thursday? Give me a call."), "call");
  assert.equal(classifyReply("Delivery Status Notification (Failure)", "Address not found", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"), "bounce");
  assert.equal(classifyReply("Re: Inquiry", "Please remove me from your list."), "not_interested");
  assert.equal(classifyReply("Re: Inquiry", "Yes it's available. Revenue is up 12% this year."), "interested");
  // The quoted original mustn't decide the class.
  assert.equal(classifyReply("Re: Inquiry", "It's available.\n\nOn Tue, Nov 24, 2026 at 9:00 AM Alex wrote:\n> I'm glad to sign an NDA"), "interested");
});

test("the sending window follows the configured timezone", () => {
  const s = { ...DEFAULT_OUTREACH, windowStart: 8, windowEnd: 18, weekdaysOnly: true, timezone: "America/New_York" };
  assert.equal(inWindow(s, new Date("2026-11-25T15:00:00Z")), true); // Wednesday 10:00 in New York
  assert.equal(inWindow(s, new Date("2026-11-25T04:00:00Z")), false); // Tuesday 23:00
  assert.equal(inWindow(s, new Date("2026-11-28T15:00:00Z")), false); // Saturday
  assert.equal(inWindow({ ...s, weekdaysOnly: false }, new Date("2026-11-28T15:00:00Z")), true);
});
