// Types shared by the Worker (worker/src) and the React app (src). No runtime dependencies.

export const STAGES = ["new", "shortlist", "contacted", "conversation", "nda", "review", "loi", "diligence", "closed", "passed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  shortlist: "Shortlist",
  contacted: "Contacted",
  conversation: "In conversation",
  nda: "NDA signed",
  review: "Reviewing financials",
  loi: "LOI",
  diligence: "Due diligence",
  closed: "Closed",
  passed: "Passed",
};

/** Stages shown as pipeline columns (closed and passed are terminal and listed separately). */
export const ACTIVE_STAGES: Stage[] = ["new", "shortlist", "contacted", "conversation", "nda", "review", "loi", "diligence"];

export type Tri = "yes" | "no" | "unknown";
export type OwnerStays = "yes" | "transition" | "no" | "unknown";
export type Remote = "yes" | "partial" | "no" | "unknown";
export type OwnerRole = "absentee" | "semi" | "operator" | "unknown";
export type ListingStatus = "active" | "pending" | "sold" | "removed";
export type ContactChannel = "email" | "form" | "phone" | "unknown";
export type NdaStatus = "none" | "requested" | "signed";

export interface FitPart {
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface Listing {
  id: number;
  source: string;
  sourceId: string;
  url: string | null;
  title: string;
  description: string | null;
  industry: string | null;
  /** Business model, e.g. "SaaS", "eCommerce", "Service", "Restaurant". */
  model: string | null;
  location: string | null;
  state: string | null;
  country: string | null;
  askingPrice: number | null;
  revenue: number | null;
  /** Seller's discretionary earnings / cash flow, annual. */
  cashFlow: number | null;
  ebitda: number | null;
  inventory: number | null;
  ffe: number | null;
  realEstate: string | null;
  established: number | null;
  employees: number | null;
  /** When the listing went online at the source (ms). Falls back to firstSeen for "days online". */
  listedAt: number | null;
  firstSeen: number;
  lastSeen: number;
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
  /** 0-5, computed from the buy box's synergy keywords. */
  synergy: number;
  /** 0-5 set by hand; wins over the computed value. */
  synergyOverride: number | null;
  synergyNotes: string | null;
  fitScore: number;
  fitBreakdown: FitPart[];
  stage: Stage;
  stageAt: number;
  starred: number;
  contactId: number | null;
  contactChannel: ContactChannel;
  contactedAt: number | null;
  lastContactAt: number | null;
  contactCount: number;
  repliedAt: number | null;
  ndaStatus: NdaStatus;
  cimReceived: number;
  status: ListingStatus;
  dupOf: number | null;
  tags: string[];
  /** Fields edited by hand; imports never overwrite them. */
  locked: string[];
  createdAt: number;
  updatedAt: number;
  // Joined / derived, present on list and detail responses:
  contactName?: string | null;
  contactEmail?: string | null;
  daysOnline?: number;
  multiple?: number | null;
}

/** What importers, the clipper and agents send. Everything except title is optional. */
export interface ListingInput {
  source?: string;
  sourceId?: string;
  url?: string | null;
  title: string;
  description?: string | null;
  industry?: string | null;
  model?: string | null;
  location?: string | null;
  state?: string | null;
  country?: string | null;
  askingPrice?: number | null;
  revenue?: number | null;
  cashFlow?: number | null;
  ebitda?: number | null;
  inventory?: number | null;
  ffe?: number | null;
  realEstate?: string | null;
  established?: number | null;
  employees?: number | null;
  listedAt?: number | null;
  sellerFinancing?: Tri;
  financingNotes?: string | null;
  sbaEligible?: Tri;
  reasonForSelling?: string | null;
  ownerRole?: OwnerRole;
  ownerHours?: number | null;
  ownerStays?: OwnerStays;
  transitionNotes?: string | null;
  remoteManageable?: Remote;
  homeBased?: number | null;
  franchise?: number | null;
  status?: ListingStatus;
  tags?: string[];
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactCompany?: string | null;
  contactRole?: "broker" | "owner" | "other";
  /** Full page text; archived to R2 and mined for signals, never stored in D1. */
  rawText?: string | null;
}

export interface Contact {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: "broker" | "owner" | "other";
  notes: string | null;
  doNotContact: number;
  createdAt: number;
  listings?: number;
  lastContactAt?: number | null;
}

export interface Note {
  id: number;
  listingId: number;
  at: number;
  author: string;
  body: string;
}

export interface EventRow {
  id: number;
  at: number;
  actor: string;
  listingId: number | null;
  type: string;
  message: string | null;
  title?: string | null;
}

export interface Template {
  id: number;
  name: string;
  subject: string;
  body: string;
  updatedAt: number;
}

export interface SequenceStep {
  templateId: number;
  /** Days after the previous step was sent (0 for the first step). */
  delayDays: number;
}

export interface Sequence {
  id: number;
  name: string;
  /** "listing": inquiry about one listing. "broker": buy-box introduction to a broker, no listing. */
  target: "listing" | "broker";
  /** "email": sent from Gmail by the bridge. "form": typed into the marketplace's contact form by the browser runner. */
  channel: "email" | "form";
  steps: SequenceStep[];
  /** 1 = follow-ups are approved automatically; the first email always waits for approval unless autoFirst is 1. */
  autoFollowups: number;
  autoFirst: number;
  enabled: number;
}

/** needs_human: the runner couldn't finish a contact form (CAPTCHA, sign-in, unusual form); do it by hand. */
export type MessageStatus = "draft" | "approved" | "sending" | "sent" | "failed" | "skipped" | "received" | "needs_human";

export interface Message {
  id: number;
  enrollmentId: number | null;
  listingId: number | null;
  contactId: number | null;
  direction: "out" | "in";
  channel: "email" | "form";
  /** Form messages: the listing page whose contact form gets the message. */
  url: string | null;
  step: number;
  toEmail: string | null;
  fromEmail: string | null;
  subject: string;
  body: string;
  status: MessageStatus;
  scheduledAt: number | null;
  sentAt: number | null;
  gmailId: string | null;
  threadId: string | null;
  error: string | null;
  classification: string | null;
  createdAt: number;
  listingTitle?: string | null;
  contactName?: string | null;
  sequenceName?: string | null;
}

export interface SavedSearch {
  id: number;
  source: string;
  name: string;
  /** Source-specific: API query parameters as JSON, or a page URL for the generic importer. */
  query: string;
  everyHours: number;
  enabled: number;
  lastRun: number | null;
  lastCount: number | null;
  lastNew: number | null;
  lastError: string | null;
  cursor?: string | null;
}

export interface DocumentRow {
  id: number;
  listingId: number;
  filename: string;
  contentType: string;
  size: number;
  kind: "cim" | "nda" | "financials" | "snapshot" | "other";
  uploadedAt: number;
}

export interface BuyBox {
  priceMin: number | null;
  priceMax: number | null;
  cashFlowMin: number | null;
  multipleMax: number | null;
  industriesInclude: string[];
  industriesExclude: string[];
  keywordsExclude: string[];
  /** US state codes or country names; empty = anywhere. Ignored for remote-manageable businesses. */
  locations: string[];
  requireRemote: boolean;
  preferSellerFinancing: boolean;
  preferOwnerStays: boolean;
  /** What you already own / are good at, in your own words. Used in outreach as {{buy_box}} context. */
  synergyProfile: string;
  synergyKeywords: string[];
}

export interface OutreachSettings {
  myName: string;
  myCompany: string;
  myPhone: string;
  /** The address brokers should reply to; typed into marketplace contact forms. */
  myEmail: string;
  /** One or two sentences about you as a buyer; {{buyer_intro}} in templates. */
  buyerIntro: string;
  signature: string;
  dailyCap: number;
  /** Marketplace contact forms submitted per day by the browser runner. */
  formDailyCap: number;
  perPoll: number;
  windowStart: number;
  windowEnd: number;
  weekdaysOnly: boolean;
  timezone: string;
  paused: boolean;
}

export interface ListingDetail {
  listing: Listing;
  contact: Contact | null;
  notes: Note[];
  events: EventRow[];
  messages: Message[];
  documents: DocumentRow[];
  priceHistory: { at: number; askingPrice: number | null }[];
  duplicate: { id: number; title: string; source: string } | null;
}

export interface Facets {
  sources: { value: string; n: number }[];
  industries: { value: string; n: number }[];
  stages: Record<string, number>;
}

export interface Analytics {
  totals: { listings: number; active: number; contacted: number; replied: number; inPlay: number; avgFit: number };
  byStage: { stage: Stage; n: number }[];
  bySource: { source: string; n: number; contacted: number; replied: number }[];
  byIndustry: { industry: string; n: number; medianMultiple: number | null; avgFit: number }[];
  daysOnline: { bucket: string; n: number }[];
  newPerWeek: { week: string; n: number }[];
  outreach: { sent: number; replied: number; pending: number; failed: number; byStep: { step: number; sent: number; replied: number }[]; byClass: { classification: string; n: number }[] };
  signals: { sellerFinancing: number; ownerStays: number; remote: number; priceDrops: number };
}

export interface PublicSummary {
  enabled: boolean;
  demo: boolean;
  generatedAt: string;
  totals?: { tracked: number; contacted: number; conversations: number; sources: number };
  byStage?: { stage: Stage; n: number }[];
  bySource?: { source: string; n: number }[];
  byIndustry?: { industry: string; n: number }[];
}

// ---------- NDAs ----------

export interface NdaFlag {
  /** red: read it before signing. amber: common in broker NDAs, worth knowing about. */
  level: "red" | "amber";
  label: string;
  quote: string;
}

/** A field for the signer; positions are percentages of the page from its top-left corner. */
export interface NdaField {
  type: "SIGNATURE" | "DATE" | "TEXT";
  page: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  /** TEXT only: printed on the document as-is. */
  text?: string;
}

/** generated: our own document. anchored: the buyer's signature line was found. guess / fallback: check the placement. */
export type NdaPlacement = "generated" | "anchored" | "guess" | "fallback";

/** to_sign: live in Documenso, waiting for your signature. failed: Documenso refused it; retry. void: cancelled. */
export type NdaState = "to_sign" | "signed" | "failed" | "void";

export interface Nda {
  id: number;
  listingId: number | null;
  contactId: number | null;
  /** ours: the buyer's own confidentiality agreement. theirs: a PDF the broker or owner sent. */
  kind: "ours" | "theirs";
  status: NdaState;
  title: string;
  counterparty: string | null;
  counterpartyEmail: string | null;
  sourceDocId: number | null;
  signedDocId: number | null;
  envelopeId: string | null;
  signingUrl: string | null;
  flags: NdaFlag[];
  placement: NdaPlacement;
  /** 1: cleared for the browser runner to sign without asking. */
  auto: number;
  attempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  signedAt: number | null;
  listingTitle?: string | null;
}

export interface NdaSettings {
  /** The name that signs. Falls back to the outreach sender's name. */
  legalName: string;
  title: string;
  address: string;
  /** Governing law for our own NDA, e.g. "the State of Texas". */
  state: string;
  termYears: number;
  /** off: every NDA waits for your click. mine: the runner signs our own NDA. clean: also theirs, when nothing is flagged red and the signature line was found. */
  autoSign: "off" | "mine" | "clean";
  /** A broker asks for an NDA and attaches none: send ours, or wait for theirs. */
  onRequest: "send_mine" | "wait";
  /** Email the signed copy back in the same thread, with a request for the CIM. */
  returnByEmail: boolean;
  returnMessage: string;
  template: string;
}
