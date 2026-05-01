import { loadNotebook, normalizePages } from "./notebookState.js";

const STORY_API = "/api/story";
const fallbackProcess = {
  title: "Process",
  subtitle: "Separate machine lane for story safety.",
  status: [
    {
      label: "Offline",
      body: "The process API is not connected. Story pages can still be edited locally.",
    },
  ],
  chapters: [],
  kept_out_of_story_pages: [],
};

async function requestJson(path, options = {}) {
  const response = await fetch(`${STORY_API}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Story API failed: ${response.status}`);
  }
  return payload;
}

export async function loadStoryNotebook(fallbackPages) {
  try {
    const payload = await requestJson("/pages");
    return {
      pages: normalizePages(payload.pages, fallbackPages),
      source: "story-db",
    };
  } catch {
    return {
      pages: loadNotebook(fallbackPages),
      source: "local",
    };
  }
}

export async function saveStoryNotebook(pages) {
  try {
    await requestJson("/pages", {
      method: "PUT",
      body: JSON.stringify({ pages }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function resetStoryNotebook(fallbackPages) {
  try {
    const payload = await requestJson("/reset", { method: "POST" });
    return {
      pages: normalizePages(payload.pages, fallbackPages),
      source: "story-db",
    };
  } catch {
    return {
      pages: normalizePages(fallbackPages, fallbackPages),
      source: "local",
    };
  }
}

export async function loadStoryProcess() {
  try {
    const payload = await requestJson("/process");
    return payload.process ?? fallbackProcess;
  } catch {
    return fallbackProcess;
  }
}

export async function searchCoverPhotos(query) {
  const safeQuery = encodeURIComponent(query || "quiet writing room");
  const payload = await requestJson(`/covers?q=${safeQuery}`);
  return {
    source: payload.source ?? "unknown",
    covers: Array.isArray(payload.covers) ? payload.covers : [],
  };
}

export async function trackCoverDownload(cover) {
  if (!cover?.downloadLocation) return false;
  try {
    const payload = await requestJson("/covers/download", {
      method: "POST",
      body: JSON.stringify({ downloadLocation: cover.downloadLocation }),
    });
    return Boolean(payload.tracked);
  } catch {
    return false;
  }
}
