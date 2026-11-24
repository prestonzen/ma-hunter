import { addNote, buyBox, getDetail, listListings, upsertListings } from "./listings";
import { claimDue, markFailed, markSent, outreachSettings } from "./outreach";
import { HttpError } from "./types";
import type { Env, ListingInput } from "./types";

/**
 * MCP server (stateless Streamable HTTP, JSON responses) for AI agents: Claude Code, Codex, or any
 * client that can send a bearer header. Agents source listings into the hub and can work the
 * contact-form queue with their own browser. The same operations exist over REST at /api/agent/*.
 */

const TOOLS = [
  {
    name: "get_buy_box",
    description: "The acquisition criteria: price range, minimum cash flow, target and excluded industries, locations, and what makes a business a synergy fit. Read this before sourcing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_listings",
    description: "Search the listings already in the hub. Use it before adding one, to avoid duplicates, and to find listings to research.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Text to find in the title, description, industry or location" },
        stage: { type: "string", description: "Comma-separated stages: new, shortlist, contacted, conversation, nda, review, loi, diligence, closed, passed" },
        source: { type: "string" },
        minFit: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_listing",
    description: "Everything known about one listing: fields, fit breakdown, notes, timeline and messages.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "upsert_listings",
    description:
      "Add businesses for sale, or refresh ones already tracked (matched by source + sourceId, else by URL). Send what the listing states and leave out what it doesn't: never guess a number. Pass the page's visible text as rawText and the hub extracts seller financing, reason for selling, owner involvement and transition terms itself.",
    inputSchema: {
      type: "object",
      properties: {
        listings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" }, source: { type: "string", description: "Marketplace slug, e.g. bizbuysell, flippa. Derived from the URL when omitted." },
              sourceId: { type: "string", description: "The marketplace's listing number" },
              title: { type: "string" }, description: { type: "string" }, industry: { type: "string" }, model: { type: "string" }, location: { type: "string" },
              askingPrice: { type: "number" }, revenue: { type: "number" }, cashFlow: { type: "number", description: "Annual SDE / cash flow in dollars" }, ebitda: { type: "number" },
              established: { type: "number" }, employees: { type: "number" }, listedAt: { type: "number", description: "When it was listed, ms since epoch" },
              sellerFinancing: { enum: ["yes", "no", "unknown"] }, reasonForSelling: { type: "string" },
              ownerStays: { enum: ["yes", "transition", "no", "unknown"] }, remoteManageable: { enum: ["yes", "partial", "no", "unknown"] },
              contactName: { type: "string" }, contactEmail: { type: "string" }, contactPhone: { type: "string" }, contactCompany: { type: "string" },
              rawText: { type: "string", description: "Visible text of the listing page" },
            },
            required: ["title"],
          },
        },
      },
      required: ["listings"],
    },
  },
  {
    name: "add_note",
    description: "Attach a research note to a listing (what you found, red flags, questions to ask).",
    inputSchema: { type: "object", properties: { id: { type: "number" }, note: { type: "string" } }, required: ["id", "note"] },
  },
  {
    name: "next_contact_task",
    description:
      "Claim the next approved contact-form inquiry. Returns the listing page URL, the exact message to send and the sender's details. Open the page, find the listing's contact form, fill it in exactly as given and submit it. Then call report_contact. Never solve a CAPTCHA or create an account: report needs_human instead.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "report_contact",
    description: "Report the outcome of a contact task: sent (the form confirmed submission), needs_human (CAPTCHA, sign-in wall, no form found), or failed.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "number" }, outcome: { enum: ["sent", "needs_human", "failed"] }, detail: { type: "string" } },
      required: ["messageId", "outcome"],
    },
  },
];

type Args = Record<string, unknown>;

export async function callTool(env: Env, agent: string, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "get_buy_box":
      return buyBox(env);
    case "search_listings": {
      const r = await listListings(env, { q: a.q as string, stage: a.stage as string, source: a.source as string, minFit: Number(a.minFit) || undefined, limit: Math.min(Number(a.limit) || 25, 100) });
      return { total: r.total, listings: r.items.map((l) => ({ id: l.id, title: l.title, source: l.source, sourceId: l.sourceId, url: l.url, stage: l.stage, status: l.status, fitScore: l.fitScore, askingPrice: l.askingPrice, cashFlow: l.cashFlow, industry: l.industry, location: l.location, daysOnline: l.daysOnline })) };
    }
    case "get_listing":
      return getDetail(env, Number(a.id));
    case "upsert_listings": {
      const listings = a.listings as ListingInput[];
      if (!Array.isArray(listings) || !listings.length) throw new HttpError(400, "listings must be a non-empty array");
      if (listings.length > 100) throw new HttpError(400, "send at most 100 listings per call");
      return upsertListings(env, listings, agent);
    }
    case "add_note":
      await addNote(env, Number(a.id), agent, String(a.note ?? ""));
      return { ok: true };
    case "next_contact_task":
      return nextContactTask(env);
    case "report_contact":
      return reportContact(env, agent, { messageId: Number(a.messageId), outcome: String(a.outcome), detail: a.detail as string | undefined });
    default:
      throw new HttpError(404, `unknown tool: ${name}`);
  }
}

export async function nextContactTask(env: Env) {
  const { messages, reason } = await claimDue(env, "form", 1);
  if (!messages.length) return { task: null, reason: reason ?? "No approved contact-form messages are waiting" };
  const s = await outreachSettings(env);
  const m = messages[0];
  return { task: { kind: "contact", messageId: m.id, url: m.url, listing: m.listingTitle, subject: m.subject, message: m.body, sender: { name: s.myName, email: s.myEmail, phone: s.myPhone, company: s.myCompany } } };
}

export async function reportContact(env: Env, actor: string, r: { messageId: number; outcome: string; detail?: string }) {
  if (r.outcome === "sent") await markSent(env, r.messageId, {}, actor);
  else await markFailed(env, r.messageId, r.detail?.trim() || (r.outcome === "needs_human" ? "The form needs a person" : "The form could not be submitted"), r.outcome === "needs_human");
  return { ok: true };
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: string; arguments?: Args };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function handleOne(env: Env, agent: string, req: RpcRequest): Promise<unknown | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  switch (req.method) {
    case "initialize":
      return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ma-hunter", version: "0.1.0" }, instructions: "M&A Hunter: source businesses for sale into one pipeline. Call get_buy_box first; search_listings before adding; never invent numbers a listing doesn't state." });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        const out = await callTool(env, agent, req.params?.name ?? "", req.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

export async function handleMcp(request: Request, env: Env, agent: string): Promise<Response> {
  if (request.method !== "POST") return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "This MCP server is stateless: POST JSON-RPC requests" } }, 405);
  let body: RpcRequest | RpcRequest[];
  try {
    body = (await request.json()) as RpcRequest | RpcRequest[];
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((r) => handleOne(env, agent, r)))).filter((x) => x !== null);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleOne(env, agent, body);
  return out === null ? new Response(null, { status: 202 }) : json(out);
}
