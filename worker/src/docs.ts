import { db, logEvent } from "./db";
import { getListing } from "./listings";
import { HttpError } from "./types";
import type { DocumentRow, Env } from "./types";

/** Deal documents (CIMs, NDAs, financials) live in a private R2 bucket and are only served to the admin. */

const MAX_BYTES = 25 * 1024 * 1024;
const KINDS = ["cim", "nda", "financials", "other"];

export async function uploadDocument(env: Env, listingId: number, req: Request, actor: string): Promise<DocumentRow> {
  await getListing(env, listingId);
  const url = new URL(req.url);
  const filename = (url.searchParams.get("filename") ?? "document").replace(/[^\w.() -]+/g, "_").slice(0, 140);
  const kind = KINDS.includes(url.searchParams.get("kind") ?? "") ? url.searchParams.get("kind")! : "other";
  const body = await req.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, "the file is empty");
  if (body.byteLength > MAX_BYTES) throw new HttpError(413, "files are limited to 25 MB");
  const contentType = req.headers.get("Content-Type") || "application/octet-stream";
  const now = Date.now();
  const key = `docs/${listingId}/${now}-${filename}`;
  await env.FILES.put(key, body, { httpMetadata: { contentType } });
  const row = await (await db(env))
    .prepare("INSERT INTO documents (listingId, key, filename, contentType, size, kind, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, listingId, filename, contentType, size, kind, uploadedAt")
    .bind(listingId, key, filename, contentType, body.byteLength, kind, now)
    .first<DocumentRow>();
  if (kind === "cim") await (await db(env)).prepare("UPDATE listings SET cimReceived = 1 WHERE id = ?").bind(listingId).run();
  if (kind === "nda") await (await db(env)).prepare("UPDATE listings SET ndaStatus = 'signed' WHERE id = ? AND ndaStatus != 'signed'").bind(listingId).run();
  await logEvent(env, { actor, listingId, type: "document", message: `Uploaded ${kind === "other" ? "" : `${kind.toUpperCase()}: `}${filename}` });
  return row!;
}

export async function downloadDocument(env: Env, id: number): Promise<Response> {
  const row = await (await db(env)).prepare("SELECT key, filename, contentType FROM documents WHERE id = ?").bind(id).first<{ key: string; filename: string; contentType: string }>();
  if (!row) throw new HttpError(404, "document not found");
  const obj = await env.FILES.get(row.key);
  if (!obj) throw new HttpError(404, "the file is missing from storage");
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.contentType,
      "Content-Disposition": `${row.contentType.startsWith("text/") || row.contentType === "application/pdf" ? "inline" : "attachment"}; filename="${row.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

export async function deleteDocument(env: Env, id: number): Promise<void> {
  const d = await db(env);
  const row = await d.prepare("SELECT key FROM documents WHERE id = ?").bind(id).first<{ key: string }>();
  if (!row) return;
  await env.FILES.delete(row.key);
  await d.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
}
