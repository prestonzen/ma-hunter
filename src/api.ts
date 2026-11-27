import type { Analytics, BuyBox, Contact, EventRow, Facets, Listing, ListingDetail, ListingInput, Message, Nda, NdaSettings, OutreachSettings, PublicSummary, QuantItem, QuantReport, QuantView, SavedSearch, Sequence, Template, Valuation } from "../shared/types";
import type { Underwriting } from "../shared/underwrite";

export interface ListingValuation {
  valuation: Valuation | null;
  comps: (QuantItem & { score: number })[];
  underwriting: Underwriting;
  fitAt: number | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `The hub answered ${res.status}`);
  return data as T;
}

const get = <T>(path: string) => call<T>(path);
const send = <T>(method: string, path: string, body?: unknown) => call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface Status {
  mock: boolean;
  origin: string;
  gmailBridge: { account?: string | null; at: number } | null;
  runners: { name: string; at: number; capabilities?: string[] }[];
  configured: { bridgeToken: boolean; agents: string[]; flippaToken: boolean; publicDashboard: boolean; documenso: boolean };
  queue: { drafts: number; approved: number; needsHuman: number; failed: number };
  alertDomains: string[];
}

export interface NdaList {
  items: Nda[];
  settings: NdaSettings;
  configured: boolean;
  documensoUrl: string | null;
}

export type SequenceRow = Sequence & { active: number; replied: number; total: number };
export type ListQuery = Record<string, string | number | boolean | undefined>;

const qs = (q: ListQuery) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && v !== false) p.set(k, v === true ? "1" : String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  summary: () => get<PublicSummary>("/api/public/summary"),
  me: () => get<{ user: string; mock: boolean }>("/api/admin/me"),
  login: (token: string) => send<{ ok: true }>("POST", "/api/admin/login", { token }),
  logout: () => send<{ ok: true }>("POST", "/api/admin/logout"),
  status: () => get<Status>("/api/admin/status"),
  analytics: () => get<Analytics>("/api/admin/analytics"),
  events: (limit = 40) => get<EventRow[]>(`/api/admin/events?limit=${limit}`),

  listings: (q: ListQuery) => get<{ items: Listing[]; total: number; facets: Facets }>(`/api/admin/listings${qs(q)}`),
  csvUrl: (q: ListQuery) => `/api/admin/listings.csv${qs(q)}`,
  listing: (id: number) => get<ListingDetail>(`/api/admin/listings/${id}`),
  createListing: (l: ListingInput) => send<ListingDetail>("POST", "/api/admin/listings", l),
  upsert: (listings: ListingInput[]) => send<{ created: number; updated: number; results: { id: number; created: boolean; title: string }[] }>("POST", "/api/admin/listings/upsert", { listings }),
  patchListing: (id: number, patch: Record<string, unknown>) => send<ListingDetail>("PATCH", `/api/admin/listings/${id}`, patch),
  deleteListing: (id: number) => send<{ ok: true }>("DELETE", `/api/admin/listings/${id}`),
  bulk: (ids: number[], action: { patch?: Record<string, unknown>; sequenceId?: number }) => send<{ ok: number; errors: string[] }>("POST", "/api/admin/listings/bulk", { ids, ...action }),
  addNote: (id: number, body: string) => send<ListingDetail>("POST", `/api/admin/listings/${id}/notes`, { body }),
  logContact: (id: number, channel: string, note: string) => send<ListingDetail>("POST", `/api/admin/listings/${id}/contact-log`, { channel, note }),
  setContact: (id: number, c: Partial<Contact>) => send<ListingDetail>("PUT", `/api/admin/listings/${id}/contact`, c),
  enroll: (id: number, sequenceId: number) => send<ListingDetail>("POST", `/api/admin/listings/${id}/enroll`, { sequenceId }),
  upload: async (id: number, file: File, kind: string) => {
    const res = await fetch(`/api/admin/listings/${id}/documents?filename=${encodeURIComponent(file.name)}&kind=${kind}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" }, credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as ListingDetail & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
    return data;
  },
  deleteDocument: (id: number) => send<{ ok: true }>("DELETE", `/api/admin/documents/${id}`),

  previewUrl: (url: string) => send<{ listing: ListingInput; textLength: number }>("POST", "/api/admin/import/url", { url }),
  saveUrl: (url: string, listing: ListingInput) => send<{ created: number; updated: number; results: { id: number }[] }>("POST", "/api/admin/import/url/save", { url, listing }),
  previewPage: (page: unknown) => send<{ listing: ListingInput }>("POST", "/api/admin/import/page", page),
  previewCards: (cards: unknown[]) => send<{ listings: (ListingInput & { isNew: boolean })[] }>("POST", "/api/admin/import/cards", { cards }),

  settings: () => get<{ buybox: BuyBox; outreach: OutreachSettings }>("/api/admin/settings"),
  saveBuyBox: (b: BuyBox) => send<{ buybox: BuyBox; rescored: number }>("PUT", "/api/admin/settings/buybox", b),
  saveOutreach: (s: Partial<OutreachSettings>) => send<{ outreach: OutreachSettings }>("PUT", "/api/admin/settings/outreach", s),

  contacts: () => get<Contact[]>("/api/admin/contacts"),
  createContact: (c: Partial<Contact>) => send<{ id: number }>("POST", "/api/admin/contacts", c),
  patchContact: (id: number, c: Partial<Contact>) => send<{ ok: true }>("PATCH", `/api/admin/contacts/${id}`, c),
  enrollContact: (id: number, sequenceId: number) => send<{ enrollmentId: number }>("POST", `/api/admin/contacts/${id}/enroll`, { sequenceId }),

  templates: () => get<Template[]>("/api/admin/templates"),
  saveTemplate: (t: Partial<Template>) => (t.id ? send<{ id: number }>("PATCH", `/api/admin/templates/${t.id}`, t) : send<{ id: number }>("POST", "/api/admin/templates", t)),
  deleteTemplate: (id: number) => send<{ ok: true }>("DELETE", `/api/admin/templates/${id}`),
  sequences: () => get<SequenceRow[]>("/api/admin/sequences"),
  saveSequence: (s: Partial<Sequence>) => (s.id ? send<{ id: number }>("PATCH", `/api/admin/sequences/${s.id}`, s) : send<{ id: number }>("POST", "/api/admin/sequences", s)),
  messages: (q: ListQuery = {}) => get<Message[]>(`/api/admin/messages${qs(q)}`),
  patchMessage: (id: number, p: { subject?: string; body?: string; status?: string }) => send<{ ok: true }>("PATCH", `/api/admin/messages/${id}`, p),
  approve: (ids: number[]) => send<{ ok: number }>("POST", "/api/admin/messages/approve", { ids }),
  markSent: (id: number) => send<{ ok: true }>("POST", `/api/admin/messages/${id}/sent`),
  stopEnrollment: (id: number) => send<{ ok: true }>("POST", `/api/admin/enrollments/${id}/stop`),

  searches: () => get<SavedSearch[]>("/api/admin/searches"),
  saveSearch: (s: Partial<SavedSearch>) => (s.id ? send<{ id: number }>("PATCH", `/api/admin/searches/${s.id}`, s) : send<{ id: number }>("POST", "/api/admin/searches", s)),
  deleteSearch: (id: number) => send<{ ok: true }>("DELETE", `/api/admin/searches/${id}`),
  runSearch: (id: number) => send<{ count: number; created: number }>("POST", `/api/admin/searches/${id}/run`),
  ndas: (listingId?: number) => get<NdaList>(`/api/admin/ndas${listingId ? `?listingId=${listingId}` : ""}`),
  createNda: (listingId: number) => send<Nda>("POST", `/api/admin/listings/${listingId}/nda`),
  uploadNda: async (listingId: number, file: File) => {
    const res = await fetch(`/api/admin/listings/${listingId}/nda/upload?filename=${encodeURIComponent(file.name)}`, { method: "POST", body: file, headers: { "Content-Type": "application/pdf" }, credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as Nda & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
    return data;
  },
  syncNda: (id: number) => send<Nda>("POST", `/api/admin/ndas/${id}/sync`),
  syncNdas: () => send<{ checked: number; signed: number }>("POST", "/api/admin/ndas/sync"),
  retryNda: (id: number) => send<Nda>("POST", `/api/admin/ndas/${id}/retry`),
  autoNda: (id: number, auto: boolean) => send<{ ok: true }>("POST", `/api/admin/ndas/${id}/auto`, { auto }),
  voidNda: (id: number) => send<{ ok: true }>("POST", `/api/admin/ndas/${id}/void`),
  quant: () => get<QuantView>("/api/admin/quant"),
  refitQuant: () => send<{ report: QuantReport | null; priced: number }>("POST", "/api/admin/quant/refit"),
  saveUnderwriting: (u: Partial<Underwriting>) => send<{ underwriting: Underwriting }>("PUT", "/api/admin/settings/underwriting", u),
  valuation: (id: number) => get<ListingValuation>(`/api/admin/listings/${id}/valuation`),
  saveNdaSettings: (s: Partial<NdaSettings>) => send<{ settings: NdaSettings }>("PUT", "/api/admin/settings/nda", s),

  demoSeed: () => send<{ listings: number; seeded: boolean }>("POST", "/api/admin/demo-seed"),
};
