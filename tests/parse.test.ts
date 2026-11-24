import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSignals, htmlToText, labelled, pageFromHtml, parseAlertEmail, parseListingPage, parseMoney, parseState, sourceFromUrl, sourceIdFromUrl } from "../worker/src/parse";
import { listingLinks, mapEmpireFlippers } from "../worker/src/sources";

test("parseMoney reads the formats marketplaces use", () => {
  assert.equal(parseMoney("$1,250,000"), 1_250_000);
  assert.equal(parseMoney("$1.2M"), 1_200_000);
  assert.equal(parseMoney("450K"), 450_000);
  assert.equal(parseMoney("USD 90,000"), 90_000);
  assert.equal(parseMoney("$2.5 million"), 2_500_000);
  assert.equal(parseMoney("Not Disclosed"), null);
  assert.equal(parseMoney(""), null);
});

test("parseState finds the state in a location", () => {
  assert.equal(parseState("Austin, TX"), "TX");
  assert.equal(parseState("Travis County, Texas"), "TX");
  assert.equal(parseState("Charleston, West Virginia"), "WV");
  assert.equal(parseState("Online"), null);
});

test("source and id come from the URL", () => {
  assert.equal(sourceFromUrl("https://www.bizbuysell.com/business-opportunity/hvac-company/2291847/"), "bizbuysell");
  assert.equal(sourceIdFromUrl("https://www.bizbuysell.com/business-opportunity/hvac-company/2291847/"), "2291847");
  assert.equal(sourceIdFromUrl("https://flippa.com/11873302"), "11873302");
  assert.equal(sourceFromUrl("https://www.businessesforsale.co.uk/x"), "businessesforsale");
  assert.equal(sourceIdFromUrl("https://acquire.com/startups/hardscape-quote-ai"), "hardscape-quote-ai");
});

test("signals: seller financing, yes and no", () => {
  assert.equal(extractSignals("Seller financing available for a qualified buyer.").sellerFinancing, "yes");
  assert.equal(extractSignals("The owner will carry a note for 20%.").sellerFinancing, "yes");
  assert.equal(extractSignals("No seller financing. Cash buyers only.").sellerFinancing, "no");
  assert.equal(extractSignals("A lovely bakery downtown.").sellerFinancing, "unknown");
  assert.equal(extractSignals("This business is SBA pre-qualified.").sbaEligible, "yes");
});

test("signals: owner role, hours, transition and remote", () => {
  const a = extractSignals("Semi-absentee owner works 10 hours per week. Owner will provide 6 months of training and transition support.");
  assert.equal(a.ownerRole, "semi");
  assert.equal(a.ownerHours, 10);
  assert.equal(a.ownerStays, "transition");
  assert.equal(a.remoteManageable, "partial");
  const b = extractSignals("The founder is willing to stay on as a consultant. The business can be run remotely from anywhere.");
  assert.equal(b.ownerStays, "yes");
  assert.equal(b.remoteManageable, "yes");
  assert.equal(extractSignals("Absentee owned car wash.").ownerRole, "absentee");
  assert.equal(extractSignals("Owner-operator runs the kitchen.").ownerRole, "operator");
});

test("signals: reason for selling and motivation", () => {
  const a = extractSignals("Great margins.\nReason for Selling: Retirement\nMore text.");
  assert.equal(a.reasonForSelling, "Retirement");
  assert.equal(a.motivated, true);
  const b = extractSignals("The owner is relocating out of state and wants a quick close.");
  assert.match(b.reasonForSelling ?? "", /relocating/);
  assert.equal(extractSignals("Reason for Selling: Not disclosed").reasonForSelling, null);
});

test("labelled reads same-line and next-line values", () => {
  assert.equal(labelled("Asking Price: $450,000\nCash Flow: $120,000", /cash flow/), "$120,000");
  assert.equal(labelled("Asking Price:\n$450,000\nCash Flow:\n$120,000", /asking price/), "$450,000");
  assert.equal(labelled("Support & Training:\nOwner will train for 4 weeks.\nReason for Selling:\nRetirement", /support (?:&|and) training/), "Owner will train for 4 weeks.");
});

const MARKETPLACE_PAGE = `Established HVAC Company with Recurring Maintenance Contracts
Charlotte, NC (Mecklenburg County)
Asking Price:
$1,250,000
Cash Flow:
$410,000
Gross Revenue:
$2,300,000
EBITDA:
$380,000
FF&E:
$250,000
Inventory:
$60,000
Rent:
$4,500 per Month
Established:
2006
Business Description
Residential and light commercial HVAC with 1,400 maintenance agreements. Service manager in place.
Detailed Information
Location:
Charlotte, NC
Employees:
14
Facilities:
Leased 6,000 sq ft warehouse.
Support & Training:
Seller will stay for 90 days of training and is open to a longer consulting role.
Reason for Selling:
Retirement
Financing:
Seller financing available with 25% down. SBA pre-qualified.
Home-Based:
No
Franchise:
No
Business Listed By:
Jordan Reyes
Coastal Business Brokers`;

test("parseListingPage handles a labelled marketplace page", () => {
  const l = parseListingPage({
    url: "https://www.bizbuysell.com/business-opportunity/established-hvac-company/2299001/",
    title: "Established HVAC Company with Recurring Maintenance Contracts | BizBuySell",
    text: MARKETPLACE_PAGE,
    emails: ["jordan@coastalbb.example"],
    phones: ["+1 704 555 0100"],
  });
  assert.equal(l.title, "Established HVAC Company with Recurring Maintenance Contracts");
  assert.equal(l.source, "bizbuysell");
  assert.equal(l.sourceId, "2299001");
  assert.equal(l.askingPrice, 1_250_000);
  assert.equal(l.cashFlow, 410_000);
  assert.equal(l.revenue, 2_300_000);
  assert.equal(l.ebitda, 380_000);
  assert.equal(l.ffe, 250_000);
  assert.equal(l.inventory, 60_000);
  assert.equal(l.established, 2006);
  assert.equal(l.employees, 14);
  assert.equal(l.location, "Charlotte, NC");
  assert.equal(l.state, "NC");
  assert.equal(l.reasonForSelling, "Retirement");
  assert.equal(l.sellerFinancing, "yes");
  assert.equal(l.sbaEligible, "yes");
  assert.equal(l.ownerStays, "yes");
  assert.equal(l.homeBased, 0);
  assert.equal(l.franchise, 0);
  assert.equal(l.contactName, "Jordan Reyes");
  assert.equal(l.contactEmail, "jordan@coastalbb.example");
});

test("parseListingPage: loose labels don't steal precise ones, and missing stays missing", () => {
  const l = parseListingPage({
    url: "https://example.com/listings/blue-widget-co",
    title: "Blue Widget Co",
    text: "Blue Widget Co\nSales\nOur sales team is great.\nPrice: $300,000\nNet Profit: $90,000\nRevenue: Not Disclosed",
  });
  assert.equal(l.askingPrice, 300_000);
  assert.equal(l.cashFlow, 90_000);
  assert.equal(l.revenue, null);
  assert.equal(l.sellerFinancing, "unknown");
  assert.equal(l.reasonForSelling, null);
});

test("pageFromHtml extracts text, JSON-LD, meta and contact links", () => {
  const html =
    '<html><head><title>Cafe for sale &amp; more</title><meta property="og:description" content="A cafe.">' +
    '<script type="application/ld+json">{"@type":"Product","name":"Corner Cafe","offers":{"price":"185000"}}</script><style>.x{}</style></head>' +
    '<body><h1>Corner Cafe</h1><p>Asking Price: $185,000</p><a href="mailto:owner@cafe.example?subject=hi">Email</a><a href="tel:+15550100">Call</a><script>var x = 1;</script></body></html>';
  const p = pageFromHtml("https://example.com/listings/corner-cafe", html);
  assert.equal(p.title, "Cafe for sale & more");
  assert.deepEqual(p.emails, ["owner@cafe.example"]);
  assert.deepEqual(p.phones, ["+15550100"]);
  assert.ok(!p.text.includes("var x"));
  const l = parseListingPage(p);
  assert.equal(l.title, "Corner Cafe");
  assert.equal(l.askingPrice, 185_000);
  assert.equal(htmlToText("<p>a</p><p>b&nbsp;c</p>"), "a\nb c");
});

test("parseAlertEmail pulls listings out of a saved-search alert", () => {
  const html =
    '<table><tr><td><a href="https://www.bizbuysell.com/business-opportunity/mowing-routes/2311200/">Residential Lawn Mowing Routes, 480 Weekly Customers</a><br>Durham, NC<br>Asking Price: $385,000 &nbsp; Cash Flow: $152,000</td></tr>' +
    '<tr><td><a href="https://click.e.bizbuysell.com/?qs=abc123">Commercial Landscape Maintenance Company</a><div>Raleigh, NC</div><div>$1,450,000</div></td></tr>' +
    '<tr><td><a href="https://www.bizbuysell.com/unsubscribe">Unsubscribe from this alert</a> <a href="https://www.bizbuysell.com/">View all results</a></td></tr></table>';
  const got = parseAlertEmail({ from: "BizBuySell <alerts@e.bizbuysell.com>", subject: "3 new listings match your search", html });
  assert.equal(got.length, 2);
  assert.equal(got[0].sourceId, "2311200");
  assert.equal(got[0].askingPrice, 385_000);
  assert.equal(got[0].cashFlow, 152_000);
  assert.equal(got[0].state, "NC");
  assert.equal(got[1].title, "Commercial Landscape Maintenance Company");
  assert.equal(got[1].askingPrice, 1_450_000);
  assert.deepEqual(parseAlertEmail({ from: "someone@gmail.com", subject: "hi", html }), []);
});

test("listingLinks keeps listing pages and drops navigation", () => {
  const html =
    '<a href="/listings/12345-saas-business/">A</a><a href="/listings/page/2/">next</a><a href="/about/">About</a>' +
    '<a href="https://other.example/listings/999-x-y-z/">ext</a><a href="/businesses-for-sale/profitable-ecommerce-brand/">B</a>';
  assert.deepEqual(listingLinks("https://quietlight.example/listings/", html), [
    "https://quietlight.example/listings/12345-saas-business/",
    "https://quietlight.example/businesses-for-sale/profitable-ecommerce-brand/",
  ]);
});

test("mapEmpireFlippers maps the public API shape", () => {
  const l = mapEmpireFlippers({
    listing_number: 98677,
    public_title: "Amazon FBA Business in the Health &amp; Fitness Niche",
    summary: "Launched in 2019.",
    listing_price: 2_104_739,
    average_annual_gross_revenue: 3_423_562,
    average_annual_net_profit: 619_041,
    country: "US",
    first_made_money_at: "2019-11-01",
    first_listed_at: "2026-11-24T17:00:00.320Z",
    listing_status: "For Sale",
    hours_worked_per_week: 5,
    reason_for_sale: "The Seller would like to explore other opportunities.",
    seller_support: "30 days of support.",
    niches: [{ niche: "Health & Fitness" }],
    monetizations: [{ monetization: "Amazon FBA" }, { monetization: "eCommerce" }],
  });
  assert.equal(l.sourceId, "98677");
  assert.equal(l.title, "Amazon FBA Business in the Health & Fitness Niche");
  assert.equal(l.cashFlow, 619_041);
  assert.equal(l.established, 2019);
  assert.equal(l.ownerRole, "absentee");
  assert.equal(l.ownerStays, "transition");
  assert.equal(l.model, "Amazon FBA, eCommerce");
  assert.equal(l.remoteManageable, "yes");
});
