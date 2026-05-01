import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(appRoot, "..", "..");
const defaultDbPath = path.join(
  workspaceRoot,
  "resources",
  "cara-analysis",
  "user-story",
  "cara-notes-story.sqlite",
);
const dbPath = process.env.CARA_NOTES_STORY_DB
  ? path.resolve(process.env.CARA_NOTES_STORY_DB)
  : defaultDbPath;
const dbDir = path.dirname(dbPath);
const seedPath = path.join(appRoot, "src", "data", "readerSeed.json");
const processSidePath = path.join(
  workspaceRoot,
  "resources",
  "cara-analysis",
  "data",
  "cara-notes-process-side.json",
);
const unsplashLocalPath = path.join(
  workspaceRoot,
  "resources",
  "cara-analysis",
  "user-story",
  "unsplash.local.json",
);
const port = Number(process.env.CARA_NOTES_STORY_PORT || 4537);
const PRIVATE_SOURCE_ID_PATTERN = /\bcara-msg-src-\d+\b/g;
const URL_PATTERN = /^https:\/\/[^\s"'<>]+$/;
const UNSPLASH_APP_NAME = "cara_notes";

mkdirSync(dbDir, { recursive: true });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampPercent(value, fallback = 50) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, number));
}

function cleanUrl(value) {
  return typeof value === "string" && URL_PATTERN.test(value) ? value : "";
}

function normalizeCover(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const url = cleanUrl(candidate.url);
  if (!url) return null;

  return {
    provider: String(candidate.provider || "unsplash").slice(0, 40),
    id: String(candidate.id || url).slice(0, 120),
    url,
    thumbUrl: cleanUrl(candidate.thumbUrl || candidate.url) || url,
    alt: String(candidate.alt || "Cover image").slice(0, 220),
    color: String(candidate.color || "").slice(0, 32),
    creditName: String(candidate.creditName || candidate.userName || "Unsplash").slice(0, 120),
    creditUrl: cleanUrl(candidate.creditUrl),
    unsplashUrl: cleanUrl(candidate.unsplashUrl),
    downloadLocation: cleanUrl(candidate.downloadLocation),
    query: String(candidate.query || "").slice(0, 120),
    position: {
      x: clampPercent(candidate.position?.x, 50),
      y: clampPercent(candidate.position?.y, 50),
    },
  };
}

function scrubPrivateReferences(value) {
  if (typeof value === "string") {
    return value.replace(PRIVATE_SOURCE_ID_PATTERN, "[private source]");
  }

  if (Array.isArray(value)) {
    return value.map(scrubPrivateReferences);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubPrivateReferences(entry)]),
    );
  }

  return value;
}

function normalizePages(candidate) {
  if (!Array.isArray(candidate)) return [];

  return candidate
    .filter((page) => page && typeof page === "object")
    .map((page, index) => ({
      id: String(page.id || `page-${Date.now()}-${index}`),
      title: String(page.title || "Untitled"),
      section: String(page.section || "Writing"),
      description: String(page.description || ""),
      updated: String(page.updated || "Saved"),
      tone: String(page.tone || "plain"),
      cover: normalizeCover(page.cover),
      blocks: Array.isArray(page.blocks) && page.blocks.length > 0
        ? scrubPrivateReferences(page.blocks)
        : [{ type: "paragraph", content: "" }],
    }))
    .filter((page) => page.id !== "process" && page.section !== "System");
}

function readSeed() {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  return {
    pages: normalizePages(seed.pages),
    appRules: Array.isArray(seed.appRules) ? seed.appRules.map(String) : [],
  };
}

function readProcessSide() {
  return JSON.parse(readFileSync(processSidePath, "utf8"));
}

function readUnsplashAccessKey() {
  if (process.env.CARA_NOTES_UNSPLASH_ACCESS_KEY) {
    return process.env.CARA_NOTES_UNSPLASH_ACCESS_KEY.trim();
  }

  if (!existsSync(unsplashLocalPath)) return "";

  try {
    const config = JSON.parse(readFileSync(unsplashLocalPath, "utf8"));
    return String(config.access_key || config.accessKey || "").trim();
  } catch {
    return "";
  }
}

function withUtm(url) {
  const safeUrl = cleanUrl(url);
  if (!safeUrl) return "";
  const next = new URL(safeUrl);
  next.searchParams.set("utm_source", UNSPLASH_APP_NAME);
  next.searchParams.set("utm_medium", "referral");
  return next.toString();
}

function unsplashPhotoToCover(photo, query = "") {
  return normalizeCover({
    provider: "unsplash",
    id: photo.id,
    url: photo.urls?.regular,
    thumbUrl: photo.urls?.small || photo.urls?.thumb || photo.urls?.regular,
    alt: photo.alt_description || photo.description || "Unsplash cover image",
    color: photo.color,
    creditName: photo.user?.name || photo.user?.username || "Unsplash",
    creditUrl: withUtm(photo.user?.links?.html || photo.links?.html),
    unsplashUrl: withUtm(photo.links?.html),
    downloadLocation: photo.links?.download_location,
    query,
    position: { x: 50, y: 50 },
  });
}

function seedCoverFallback(query = "") {
  const normalized = query.trim().toLowerCase();
  const seed = readSeed();
  return seed.pages
    .map((page) => page.cover)
    .filter(Boolean)
    .filter((cover) => (
      !normalized ||
      [cover.query, cover.alt, cover.creditName].some((value) =>
        String(value || "").toLowerCase().includes(normalized),
      )
    ));
}

async function searchUnsplashCovers(query, page = 1) {
  const accessKey = readUnsplashAccessKey();
  if (!accessKey) {
    return { source: "seed-fallback", covers: seedCoverFallback(query) };
  }

  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("content_filter", "high");
  url.searchParams.set("per_page", "12");
  url.searchParams.set("page", String(page));

  const response = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
    },
    signal: AbortSignal.timeout(9000),
  });

  if (!response.ok) {
    return { source: "seed-fallback", covers: seedCoverFallback(query) };
  }

  const payload = await response.json();
  const covers = Array.isArray(payload.results)
    ? payload.results.map((photo) => unsplashPhotoToCover(photo, query)).filter(Boolean)
    : [];

  return {
    source: "unsplash",
    total: Number(payload.total || 0),
    covers: covers.length ? covers : seedCoverFallback(query),
  };
}

async function trackUnsplashDownload(downloadLocation) {
  const accessKey = readUnsplashAccessKey();
  const safeUrl = cleanUrl(downloadLocation);
  if (!accessKey || !safeUrl) return false;

  const url = new URL(safeUrl);
  if (url.hostname !== "api.unsplash.com" || !url.pathname.endsWith("/download")) {
    return false;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
    },
    signal: AbortSignal.timeout(9000),
  });

  return response.ok;
}

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS story_pages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    section TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    updated TEXT NOT NULL DEFAULT 'Saved',
    tone TEXT NOT NULL DEFAULT 'plain',
    blocks_json TEXT NOT NULL,
    process_json TEXT NOT NULL DEFAULT '[]',
    cover_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_seed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS story_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const storyPageColumns = new Set(db.prepare("PRAGMA table_info(story_pages)").all().map((column) => column.name));
if (!storyPageColumns.has("cover_json")) {
  db.exec("ALTER TABLE story_pages ADD COLUMN cover_json TEXT NOT NULL DEFAULT '{}'");
}

const selectPages = db.prepare(`
  SELECT id, title, section, description, updated, tone, cover_json, blocks_json, process_json, sort_order
  FROM story_pages
  WHERE deleted_at IS NULL
  ORDER BY sort_order ASC, created_at ASC
`);

const countPages = db.prepare("SELECT COUNT(*) AS count FROM story_pages WHERE deleted_at IS NULL");

const upsertPage = db.prepare(`
  INSERT INTO story_pages (
    id, title, section, description, updated, tone, cover_json, blocks_json, process_json, sort_order, is_seed, deleted_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    section = excluded.section,
    description = excluded.description,
    updated = excluded.updated,
    tone = excluded.tone,
    cover_json = excluded.cover_json,
    blocks_json = excluded.blocks_json,
    process_json = excluded.process_json,
    sort_order = excluded.sort_order,
    is_seed = story_pages.is_seed OR excluded.is_seed,
    deleted_at = NULL,
    updated_at = datetime('now')
`);

const softDeleteMissing = db.prepare(`
  UPDATE story_pages
  SET deleted_at = datetime('now'), updated_at = datetime('now')
  WHERE deleted_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))
`);

const deleteAllPages = db.prepare("DELETE FROM story_pages");

const upsertMeta = db.prepare(`
  INSERT INTO story_meta (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function runInTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function dbPages() {
  return selectPages.all().map((row) => ({
    id: row.id,
    title: row.title,
    section: row.section,
    description: row.description,
    updated: row.updated,
    tone: row.tone,
    cover: normalizeCover(JSON.parse(row.cover_json || "{}")),
    blocks: JSON.parse(row.blocks_json),
  }));
}

function writePagesUnsafe(pages, { seed = false } = {}) {
  const safePages = normalizePages(pages);
  safePages.forEach((page, index) => {
    upsertPage.run(
      page.id,
      page.title,
      page.section,
      page.description,
      page.updated,
      page.tone,
      JSON.stringify(page.cover ?? {}),
      JSON.stringify(page.blocks),
      JSON.stringify([]),
      index,
      seed ? 1 : 0,
    );
  });
  softDeleteMissing.run(JSON.stringify(safePages.map((page) => page.id)));
}

function replacePages(pages, { seed = false } = {}) {
  runInTransaction(() => writePagesUnsafe(pages, { seed }));
  return dbPages();
}

function resetToSeed() {
  const seed = readSeed();
  runInTransaction(() => {
    deleteAllPages.run();
    writePagesUnsafe(seed.pages, { seed: true });
    upsertMeta.run("app_rules", JSON.stringify(seed.appRules));
    upsertMeta.run("seeded_at", new Date().toISOString());
  });
  return { pages: dbPages(), appRules: seed.appRules };
}

function ensureSeeded() {
  if (countPages.get().count === 0) {
    resetToSeed();
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

ensureSeeded();

if (process.argv.includes("--seed-only")) {
  console.log(JSON.stringify({ ok: true, dbPath, pages: dbPages().length }, null, 2));
  db.close();
  process.exit(0);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/story/health") {
      sendJson(response, 200, { ok: true, dbPath, pages: countPages.get().count });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/story/pages") {
      const seed = readSeed();
      sendJson(response, 200, { ok: true, source: "story-db", pages: dbPages(), appRules: seed.appRules });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/story/process") {
      sendJson(response, 200, { ok: true, source: "process-side", process: readProcessSide() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/story/covers") {
      const query = (url.searchParams.get("q") || "quiet writing room").slice(0, 120).trim() || "quiet writing room";
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const covers = await searchUnsplashCovers(query, page);
      sendJson(response, 200, { ok: true, query, ...covers });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/story/covers/download") {
      const body = await readBody(request);
      const tracked = await trackUnsplashDownload(body.downloadLocation);
      sendJson(response, 200, { ok: true, tracked });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/story/pages") {
      const body = await readBody(request);
      const pages = replacePages(body.pages);
      sendJson(response, 200, { ok: true, source: "story-db", pages });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/story/reset") {
      const payload = resetToSeed();
      sendJson(response, 200, { ok: true, source: "story-db", ...payload });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Cara Notes story API listening on http://127.0.0.1:${port}`);
  console.log(`Story DB: ${dbPath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
