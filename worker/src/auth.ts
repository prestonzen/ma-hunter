import type { Env } from "./types";

/**
 * Admin auth = one long random ADMIN_TOKEN (a Worker secret). The admin page trades it once for a
 * signed, HttpOnly session cookie; scripts can send it as a bearer token instead. Rotating the
 * secret logs every session out.
 */

const COOKIE = "mah_admin";
const SESSION_SECONDS = 30 * 86_400;
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(env: Env, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

/** Demo mode: only ever honoured on localhost, so a stray MOCK=true in production can't open the admin. */
export const isMock = (request: Request, env: Env) => env.MOCK === "true" && isLocal(request);

const adminConfigured = (env: Env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24;

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(request: Request): string | null {
  const m = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function isAdminToken(env: Env, token: string): boolean {
  return adminConfigured(env) && timingSafeEqual(env.ADMIN_TOKEN!, token.trim());
}

/** Returns "admin" if the request carries a valid session cookie or admin bearer token, otherwise null. */
export async function adminUser(request: Request, env: Env): Promise<string | null> {
  if (isMock(request, env)) return "local-dev";
  if (!adminConfigured(env)) return null;

  const tok = bearer(request);
  if (tok && isAdminToken(env, tok)) return "admin";

  const cookie = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!cookie) return null;
  const [exp, sig] = cookie[1].split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return null;
  return timingSafeEqual(await sign(env, `admin.${exp}`), sig) ? "admin" : null;
}

export async function sessionCookie(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${COOKIE}=${exp}.${await sign(env, `admin.${exp}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function tokenMap(env: Env): Record<string, string> {
  if (!env.AGENT_TOKENS) return {};
  try {
    return JSON.parse(env.AGENT_TOKENS) as Record<string, string>;
  } catch {
    return {}; // malformed secret
  }
}

/** Agent identity comes from the bearer token, never from the request body. */
export function agentName(request: Request, env: Env): string | null {
  const tok = bearer(request);
  if (!tok || tok.length < 24) return null;
  let found: string | null = null;
  // No early exit: compare against every token so timing doesn't reveal which matched.
  for (const [name, t] of Object.entries(tokenMap(env))) {
    if (t.length >= 24 && timingSafeEqual(t, tok)) found = name.toLowerCase();
  }
  return found;
}

export function agentNames(env: Env): string[] {
  return Object.keys(tokenMap(env)).map((n) => n.toLowerCase());
}

/** The Gmail bridge (Apps Script) authenticates with its own shared secret. */
export function isBridge(request: Request, env: Env): boolean {
  const tok = bearer(request);
  const want = env.GMAIL_BRIDGE_TOKEN ?? "";
  return !!tok && want.length >= 24 && timingSafeEqual(want, tok);
}
