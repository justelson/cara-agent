export const NOTEBOOK_STORAGE_KEY = "cara-notes:notebook:v1";
export const THEME_STORAGE_KEY = "cara-notes:theme:v1";
const PRIVATE_SOURCE_ID_PATTERN = /\bcara-msg-src-\d+\b/g;
const URL_PATTERN = /^https:\/\/[^\s"'<>]+$/;

function isReaderPage(page) {
  return page.id !== "process" && page.section !== "System";
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

export function clonePages(pages) {
  return JSON.parse(JSON.stringify(pages));
}

function clampPercent(value, fallback = 50) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, number));
}

function cleanUrl(value) {
  return typeof value === "string" && URL_PATTERN.test(value) ? value : "";
}

export function normalizeCover(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const url = cleanUrl(candidate.url);
  if (!url) return null;

  const creditName = String(candidate.creditName || candidate.userName || "Unsplash").slice(0, 120);

  return {
    provider: String(candidate.provider || "unsplash").slice(0, 40),
    id: String(candidate.id || url).slice(0, 120),
    url,
    thumbUrl: cleanUrl(candidate.thumbUrl || candidate.url) || url,
    alt: String(candidate.alt || "Cover image").slice(0, 220),
    color: String(candidate.color || "").slice(0, 32),
    creditName,
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

export function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

export function createDraftPage(now = Date.now()) {
  return {
    id: `draft-${now}`,
    title: "Untitled",
    section: "Writing",
    description: "A new quiet page.",
    updated: "Now",
    tone: "plain",
    cover: null,
    blocks: [
      {
        type: "paragraph",
        content: "Start here.",
      },
    ],
  };
}

export function normalizePages(candidate, fallbackPages) {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return clonePages(fallbackPages);
  }

  const pages = candidate
    .filter((page) => page && typeof page === "object")
    .map((page, index) => ({
      id: String(page.id || `page-${index}`),
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
    .filter(isReaderPage);

  return pages.length ? pages : clonePages(fallbackPages);
}

export function loadNotebook(fallbackPages, storage = globalThis.localStorage) {
  if (!storage) return clonePages(fallbackPages);

  try {
    const raw = storage.getItem(NOTEBOOK_STORAGE_KEY);
    if (!raw) return clonePages(fallbackPages);
    const parsed = JSON.parse(raw);
    return normalizePages(parsed.pages, fallbackPages);
  } catch {
    return clonePages(fallbackPages);
  }
}

export function saveNotebook(pages, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(
      NOTEBOOK_STORAGE_KEY,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        pages,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadTheme(storage = globalThis.localStorage, fallback = "light") {
  if (!storage) return fallback;
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return saved === "dark" || saved === "light" ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function saveTheme(theme, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme === "dark" ? "dark" : "light");
    return true;
  } catch {
    return false;
  }
}

export function updatePageById(pages, pageId, patch) {
  return pages.map((page) => (
    page.id === pageId
      ? { ...page, ...patch, updated: patch.updated ?? "Edited" }
      : page
  ));
}

export function removePageById(pages, pageId) {
  if (pages.length <= 1) return pages;
  return pages.filter((page) => page.id !== pageId);
}
