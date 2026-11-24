import { db, getSetting, setSetting } from "./db";
import { addNote, logContact, patchListing, rescoreAll, upsertListings } from "./listings";
import { enroll, handleReply, listSequences, markSent } from "./outreach";
import { DAY } from "./types";
import type { BuyBox, Env, ListingInput, OutreachSettings } from "./types";

/** Demo data for `npm run demo`: fictional businesses, brokers and conversations. Never runs outside MOCK mode. */

const ago = (days: number) => Date.now() - days * DAY;

// A function, not a constant: in a Worker, Date.now() is 0 at module load.
const demoListings = (): ListingInput[] => [
  { source: "bizbuysell", sourceId: "2291847", url: "https://example.com/bizbuysell/2291847", title: "Commercial Landscape Maintenance Company, Recurring Contracts", industry: "Landscaping", model: "Service", location: "Raleigh, NC", askingPrice: 1_450_000, revenue: 2_100_000, cashFlow: 465_000, established: 2008, employees: 22, listedAt: ago(128), description: "Commercial landscape maintenance with 85% recurring contract revenue across HOAs and office parks. General manager in place handles day-to-day; owner works about 10 hours per week on estimating. Seller financing available for a qualified buyer. SBA pre-qualified. Reason for selling: retirement. Owner will provide 6 months of training and transition support.", contactName: "Dana Whitfield", contactEmail: "dana.whitfield@example-brokers.com", contactCompany: "Carolina Business Advisors" },
  { source: "bizbuysell", sourceId: "2304410", url: "https://example.com/bizbuysell/2304410", title: "Irrigation & Outdoor Lighting Installer", industry: "Landscaping", model: "Service", location: "Charlotte, NC", askingPrice: 620_000, revenue: 890_000, cashFlow: 210_000, established: 2014, employees: 7, listedAt: ago(41), description: "Design-build irrigation and low-voltage lighting. Owner-operator runs sales and scheduling. Strong builder relationships. Owner is relocating out of state and will train for 60 days.", contactName: "Marcus Bell", contactEmail: "mbell@example-brokers.com", contactCompany: "Queen City Brokers" },
  { source: "empireflippers", sourceId: "98120", url: "https://example.com/ef/98120", title: "Lawn Care Scheduling SaaS, $38K MRR", industry: "Software", model: "SaaS", location: "Online (US)", country: "US", askingPrice: 1_680_000, revenue: 456_000, cashFlow: 372_000, established: 2019, employees: 3, listedAt: ago(19), description: "B2B SaaS used by 410 lawn care and landscaping companies for route scheduling and invoicing. 2.1% monthly churn. Two contract developers; the owner works 8 hours per week on roadmap and support. The seller is happy to provide 90 days of support.", reasonForSelling: "The seller wants to focus on a new venture.", ownerHours: 8 },
  { source: "flippa", sourceId: "11873302", url: "https://example.com/flippa/11873302", title: "Garden Tools Shopify Brand with Private Label Line", industry: "eCommerce", model: "eCommerce", location: "Online", askingPrice: 340_000, revenue: 720_000, cashFlow: 118_000, established: 2020, listedAt: ago(8), description: "DTC Shopify store selling private-label pruning and hand tools. 3PL fulfilment, fully remote, 6 hours per week. 31% repeat customers. No seller financing; cash buyers only." },
  { source: "bizquest", sourceId: "BW2284519", url: "https://example.com/bizquest/BW2284519", title: "Tree Service & Stump Grinding, 3 Crews", industry: "Tree Service", model: "Service", location: "Knoxville, TN", askingPrice: 980_000, revenue: 1_750_000, cashFlow: 330_000, established: 2011, employees: 14, listedAt: ago(233), description: "Residential and municipal tree work with three crews and over $600K of equipment included. Owner works full time in the field. Price reduced. Seller will carry a note for up to 20% of the price.", contactName: "Priya Raman", contactEmail: "priya@example-ma.com", contactCompany: "Smoky Mountain M&A" },
  { source: "bizbuysell", sourceId: "2317766", url: "https://example.com/bizbuysell/2317766", title: "Franchise Sandwich Shop in Busy Strip Center", industry: "Restaurant", model: "Restaurant", location: "Tampa, FL", askingPrice: 215_000, revenue: 610_000, cashFlow: 74_000, established: 2017, employees: 9, listedAt: ago(96), description: "Established franchise location with a lease through 2031. Owner-operator. Franchise: yes. Reason for selling: other business interests." },
  { source: "bizbuysell", sourceId: "2298034", url: "https://example.com/bizbuysell/2298034", title: "Pest Control Route Business, 1,900 Recurring Accounts", industry: "Pest Control", model: "Service", location: "Greenville, SC", askingPrice: 1_150_000, revenue: 1_320_000, cashFlow: 402_000, established: 2005, employees: 11, listedAt: ago(62), description: "Quarterly and monthly residential pest accounts with 92% retention. Office manager and lead technician in place. Semi-absentee owner. Health reasons are forcing a sale. Owner is willing to stay on in a consulting role for a year. SBA eligible.", contactName: "Tom Akers", contactEmail: "takers@example-brokers.com", contactCompany: "Upstate Business Sales" },
  { source: "acquire", sourceId: "hardscape-quote-ai", url: "https://example.com/acquire/hardscape-quote-ai", title: "AI Quoting Tool for Hardscape Contractors", industry: "Software", model: "SaaS", location: "Online", askingPrice: 290_000, revenue: 96_000, cashFlow: 61_000, established: 2023, listedAt: ago(27), description: "Photo-to-quote SaaS for patio and retaining wall contractors. 140 paying accounts, $8K MRR, growing 6% monthly. Solo founder, works from anywhere. Founder is open to staying on part-time.", reasonForSelling: "Founder is pursuing a full-time role." },
  { source: "bizbuysell", sourceId: "2260915", url: "https://example.com/bizbuysell/2260915", title: "Wholesale Plant Nursery on 14 Acres (Real Estate Included)", industry: "Nursery", model: "Wholesale", location: "Athens, GA", askingPrice: 2_400_000, revenue: 1_900_000, cashFlow: 390_000, established: 1996, employees: 18, listedAt: ago(402), realEstate: "14 acres owned, included in the asking price", description: "Container nursery supplying landscapers and garden centers across three states. Second-generation owners are retiring. Seller financing is negotiable. Owners will train for up to a year.", contactName: "Lena Ortiz", contactEmail: "lena.ortiz@example-realty.com", contactCompany: "Southern Land & Business" },
  { source: "quietlight", sourceId: "17844", url: "https://example.com/quietlight/17844", title: "Outdoor Living Content Site + Affiliate, 410K Monthly Sessions", industry: "Content", model: "Content, Affiliate", location: "Online", askingPrice: 510_000, revenue: 214_000, cashFlow: 171_000, established: 2016, listedAt: ago(74), description: "Display and affiliate revenue from backyard, patio and lawn care content. Two freelance writers. Owner works 5 hours per week. 100% remote.", contactName: "Chris Vale", contactEmail: "chris@example-advisors.com", contactCompany: "Quiet Light" },
  { source: "bizbuysell", sourceId: "2311200", url: "https://example.com/bizbuysell/2311200", title: "Residential Lawn Mowing Routes, 480 Weekly Customers", industry: "Landscaping", model: "Service", location: "Durham, NC", askingPrice: 385_000, revenue: 640_000, cashFlow: 152_000, established: 2015, employees: 6, listedAt: ago(15), description: "Dense weekly mowing routes within a 12-mile radius. Two crew leads. Home-based. Owner handles billing and customer calls." },
  { source: "loopnet", sourceId: "30118842", url: "https://example.com/loopnet/30118842", title: "Self-Service Car Wash, 6 Bays", industry: "Car Wash", model: "Retail", location: "Columbus, OH", askingPrice: 760_000, revenue: 318_000, cashFlow: 139_000, established: 2003, listedAt: ago(188), realEstate: "Owned, included", description: "Absentee-owned six-bay self-serve wash with two automatic bays. Remote monitoring and card readers on every bay. Bring all offers." },
  { source: "businessbroker", sourceId: "771045", url: "https://example.com/businessbroker/771045", title: "Pool Cleaning & Repair Company", industry: "Pool Service", model: "Service", location: "Phoenix, AZ", askingPrice: 540_000, revenue: 780_000, cashFlow: 196_000, established: 2012, employees: 8, listedAt: ago(53), description: "Weekly pool service routes plus equipment repair. Owner is willing to stay for a 90 day transition. Seller financing: no." },
  { source: "flippa", sourceId: "11790455", url: "https://example.com/flippa/11790455", title: "Amazon FBA Brand: Raised Garden Beds", industry: "eCommerce", model: "Amazon FBA", location: "Online", askingPrice: 890_000, revenue: 1_600_000, cashFlow: 264_000, established: 2019, listedAt: ago(110), description: "Four hero SKUs with over 9,000 reviews. Amazon FBA with a US 3PL for overflow. The owner works 10 hours per week. Owner financing possible for the right buyer with 60% down." },
  { source: "bizbuysell", sourceId: "2275519", url: "https://example.com/bizbuysell/2275519", title: "Vape & Smoke Shop, Two Locations", industry: "Retail", model: "Retail", location: "Dallas, TX", askingPrice: 300_000, revenue: 1_100_000, cashFlow: 140_000, established: 2018, employees: 7, listedAt: ago(70), description: "Two leased retail locations with managers in place. Semi-absentee." },
  { source: "bizbuysell", sourceId: "2320087", url: "https://example.com/bizbuysell/2320087", title: "Snow Removal & Grounds Maintenance, Municipal Contracts", industry: "Landscaping", model: "Service", location: "Rochester, NY", askingPrice: 1_900_000, revenue: 3_300_000, cashFlow: 520_000, established: 1999, employees: 31, listedAt: ago(5), description: "Year-round grounds contracts with snow as 45% of revenue. Operations manager runs the crews. Financing: SBA pre-approved. Reason for Selling: Retirement." },
];

const DEMO_BOX: BuyBox = {
  priceMin: 300_000, priceMax: 2_000_000, cashFlowMin: 150_000, multipleMax: 4,
  industriesInclude: ["Landscaping", "Lawn", "Pest Control", "Tree Service", "SaaS"],
  industriesExclude: ["Restaurant", "Vape"],
  keywordsExclude: ["franchise"],
  locations: ["NC", "SC", "TN", "GA"],
  requireRemote: false, preferSellerFinancing: true, preferOwnerStays: true,
  synergyProfile: "I own a landscaping company in the Southeast and a small software studio.",
  synergyKeywords: ["landscap", "lawn", "irrigation", "outdoor", "grounds", "nursery", "hardscape", "garden"],
};

const DEMO_OUTREACH: Partial<OutreachSettings> = {
  myName: "Alex Morgan", myCompany: "Morgan Holdings", myPhone: "(555) 010-0199", myEmail: "alex@example.com",
  buyerIntro: "I'm Alex Morgan; I own a landscaping company in the Southeast and I'm looking to acquire a second business with cash and SBA financing lined up.",
};

export async function seedDemo(env: Env): Promise<{ listings: number; seeded: boolean }> {
  const d = await db(env);
  const have = (await d.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())?.n ?? 0;
  if (have > 0) return { listings: have, seeded: false };
  if (!(await getSetting(env, "buybox"))) await setSetting(env, "buybox", DEMO_BOX);
  if (!(await getSetting(env, "outreach"))) await setSetting(env, "outreach", DEMO_OUTREACH);

  const LISTINGS = demoListings();
  const { results } = await upsertListings(env, LISTINGS, "demo");
  const id = (sourceId: string) => results[LISTINGS.findIndex((l) => l.sourceId === sourceId)].id;
  // Spread "first seen" out so the charts have a shape.
  await d.batch(results.map((r, i) => d.prepare("UPDATE listings SET firstSeen = ?, createdAt = ? WHERE id = ?").bind(ago((i * 5) % 70), ago((i * 5) % 70), r.id)));
  await rescoreAll(env);

  const seqs = await listSequences(env);
  const email = seqs.find((s) => s.channel === "email" && s.target === "listing")!;
  const form = seqs.find((s) => s.channel === "form")!;

  // A conversation: emailed, the broker replied with financing detail and an NDA.
  const a = await enroll(env, { sequenceId: email.id, listingId: id("2291847") }, "demo");
  await markSent(env, a.messageId, { gmailId: "demo-out-1", threadId: "demo-thread-1", from: "alex@example.com" }, "demo");
  await handleReply(env, { id: "demo-in-1", threadId: "demo-thread-1", from: "Dana Whitfield <dana.whitfield@example-brokers.com>", subject: "Re: Inquiry", text: "Hi Alex,\n\nThanks for reaching out. The business is still available. The seller is open to financing up to 15% of the price for a buyer with industry experience, and would stay on for six months of transition.\n\nPlease sign the attached NDA and I'll send the CIM.\n\nDana" });
  await addNote(env, id("2291847"), "demo", "Strong recurring base. Ask for the contract list and customer concentration before the call.");

  // Emailed, no reply yet: the follow-up is scheduled.
  const b = await enroll(env, { sequenceId: email.id, listingId: id("2298034") }, "demo");
  await markSent(env, b.messageId, { gmailId: "demo-out-2", threadId: "demo-thread-2", from: "alex@example.com" }, "demo");
  // Waiting for approval, by email and by contact form.
  await enroll(env, { sequenceId: email.id, listingId: id("BW2284519") }, "demo");
  await enroll(env, { sequenceId: form.id, listingId: id("2311200") }, "demo");
  await enroll(env, { sequenceId: form.id, listingId: id("2320087") }, "demo");

  await patchListing(env, id("98120"), { stage: "shortlist", starred: 1 }, "demo");
  await patchListing(env, id("2304410"), { stage: "shortlist" }, "demo");
  await logContact(env, id("771045"), "demo", { channel: "phone", note: "Left a voicemail with the broker" });
  await patchListing(env, id("2260915"), { stage: "review", ndaStatus: "signed", cimReceived: 1 }, "demo");
  await patchListing(env, id("2317766"), { stage: "passed" }, "demo");
  await d.prepare("INSERT INTO searches (source, name, query, everyHours, enabled) VALUES ('empireflippers', 'Empire Flippers: under $2M', '{\"listing_price_to\": 2000000}', 12, 0), ('browser', 'BizBuySell: landscaping in NC', 'https://www.bizbuysell.com/north-carolina/landscaping-and-yard-service-businesses-for-sale/', 24, 0)").run();
  return { listings: results.length, seeded: true };
}
