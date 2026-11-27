import type { Env, EventRow } from "./types";

/**
 * D1 is the system of record. The schema lives here as ordered migrations and is applied on the first
 * request of each isolate, so a fresh database (local or remote) needs no separate migrate step.
 * Column names are camelCase on purpose: rows go to the API as-is, with no mapping layer.
 * To change the schema, append a new array to MIGRATIONS; never edit an applied one.
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, sourceId TEXT NOT NULL, url TEXT,
      title TEXT NOT NULL, description TEXT,
      industry TEXT, model TEXT, location TEXT, state TEXT, country TEXT,
      askingPrice INTEGER, revenue INTEGER, cashFlow INTEGER, ebitda INTEGER, inventory INTEGER, ffe INTEGER,
      realEstate TEXT, established INTEGER, employees INTEGER,
      listedAt INTEGER, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      sellerFinancing TEXT NOT NULL DEFAULT 'unknown', financingNotes TEXT, sbaEligible TEXT NOT NULL DEFAULT 'unknown',
      reasonForSelling TEXT,
      ownerRole TEXT NOT NULL DEFAULT 'unknown', ownerHours INTEGER,
      ownerStays TEXT NOT NULL DEFAULT 'unknown', transitionNotes TEXT,
      remoteManageable TEXT NOT NULL DEFAULT 'unknown',
      homeBased INTEGER, franchise INTEGER,
      synergy INTEGER NOT NULL DEFAULT 0, synergyOverride INTEGER, synergyNotes TEXT,
      fitScore INTEGER NOT NULL DEFAULT 0, fitBreakdown TEXT NOT NULL DEFAULT '[]',
      stage TEXT NOT NULL DEFAULT 'new', stageAt INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0,
      contactId INTEGER, contactChannel TEXT NOT NULL DEFAULT 'unknown',
      contactedAt INTEGER, lastContactAt INTEGER, contactCount INTEGER NOT NULL DEFAULT 0, repliedAt INTEGER,
      ndaStatus TEXT NOT NULL DEFAULT 'none', cimReceived INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', dupOf INTEGER,
      tags TEXT NOT NULL DEFAULT '[]', locked TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      UNIQUE (source, sourceId)
    )`,
    `CREATE INDEX IF NOT EXISTS listings_stage ON listings (stage, fitScore DESC)`,
    `CREATE INDEX IF NOT EXISTS listings_fit ON listings (fitScore DESC)`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, email TEXT, phone TEXT, company TEXT,
      role TEXT NOT NULL DEFAULT 'broker', notes TEXT,
      doNotContact INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts (email) WHERE email IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listingId INTEGER NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS notes_listing ON notes (listingId, at DESC)`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
      listingId INTEGER, type TEXT NOT NULL, message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS events_at ON events (at DESC)`,
    `CREATE INDEX IF NOT EXISTS events_listing ON events (listingId, at DESC)`,
    `CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listingId INTEGER NOT NULL, at INTEGER NOT NULL, askingPrice INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updatedAt INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'listing',
      channel TEXT NOT NULL DEFAULT 'email',
      steps TEXT NOT NULL DEFAULT '[]', autoFollowups INTEGER NOT NULL DEFAULT 1, autoFirst INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sequenceId INTEGER NOT NULL, listingId INTEGER, contactId INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', step INTEGER NOT NULL DEFAULT 0, threadId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS enrollments_thread ON enrollments (threadId)`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, enrollmentId INTEGER, listingId INTEGER, contactId INTEGER,
      direction TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email', step INTEGER NOT NULL DEFAULT 0, url TEXT,
      toEmail TEXT, fromEmail TEXT, subject TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL, scheduledAt INTEGER, sentAt INTEGER, leaseUntil INTEGER NOT NULL DEFAULT 0,
      gmailId TEXT, threadId TEXT, error TEXT, classification TEXT, createdAt INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS messages_status ON messages (status, scheduledAt)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS messages_gmail ON messages (gmailId) WHERE gmailId IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
      everyHours INTEGER NOT NULL DEFAULT 12, enabled INTEGER NOT NULL DEFAULT 1,
      lastRun INTEGER, lastCount INTEGER, lastNew INTEGER, lastError TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, cursor TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listingId INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT NOT NULL,
      contentType TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'other', uploadedAt INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS documents_listing ON documents (listingId)`,
  ],
  // 2: NDAs signed through Documenso, and outgoing messages that carry a document.
  [
    `CREATE TABLE IF NOT EXISTS ndas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listingId INTEGER, contactId INTEGER,
      kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      counterparty TEXT, counterpartyEmail TEXT,
      sourceDocId INTEGER, signedDocId INTEGER, envelopeId TEXT, signingUrl TEXT,
      flags TEXT NOT NULL DEFAULT '[]', fields TEXT NOT NULL DEFAULT '[]', placement TEXT NOT NULL DEFAULT 'generated',
      auto INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, error TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, signedAt INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS ndas_status ON ndas (status, auto)`,
    `CREATE INDEX IF NOT EXISTS ndas_listing ON ndas (listingId)`,
    `ALTER TABLE messages ADD COLUMN attachDocId INTEGER`,
  ],
  // 3: the quant layer's per-listing valuations (the model report itself lives in settings).
  [
    `CREATE TABLE IF NOT EXISTS valuations (
      listingId INTEGER PRIMARY KEY, fair REAL NOT NULL, low REAL NOT NULL, high REAL NOT NULL, gap REAL NOT NULL,
      band TEXT NOT NULL, drivers TEXT NOT NULL DEFAULT '[]', fitAt INTEGER NOT NULL
    )`,
  ],
];

const ready = new WeakMap<D1Database, Promise<void>>();

async function migrate(d: D1Database): Promise<void> {
  await d.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  const row = await d.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
  const have = row ? Number(row.value) : 0;
  for (let v = have; v < MIGRATIONS.length; v++) {
    await d.batch(MIGRATIONS[v].map((s) => d.prepare(s)));
    await d.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1").bind(String(v + 1)).run();
  }
}

/** The database, with the schema guaranteed to be current. */
export async function db(env: Env): Promise<D1Database> {
  let p = ready.get(env.DB);
  if (!p) {
    p = migrate(env.DB).catch((e) => {
      ready.delete(env.DB);
      throw e;
    });
    ready.set(env.DB, p);
  }
  await p;
  return env.DB;
}

export async function getSetting<T>(env: Env, key: string): Promise<T | null> {
  const row = await (await db(env)).prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function setSetting(env: Env, key: string, value: unknown): Promise<void> {
  await (await db(env))
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
    .bind(key, JSON.stringify(value))
    .run();
}

export async function logEvent(env: Env, e: { actor: string; listingId?: number | null; type: string; message?: string | null }): Promise<void> {
  await (await db(env))
    .prepare("INSERT INTO events (at, actor, listingId, type, message) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), e.actor, e.listingId ?? null, e.type, e.message?.slice(0, 500) ?? null)
    .run();
}

export async function recentEvents(env: Env, limit = 60): Promise<EventRow[]> {
  const { results } = await (await db(env))
    .prepare("SELECT e.*, l.title FROM events e LEFT JOIN listings l ON l.id = e.listingId ORDER BY e.at DESC, e.id DESC LIMIT ?")
    .bind(limit)
    .all<EventRow>();
  return results;
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
