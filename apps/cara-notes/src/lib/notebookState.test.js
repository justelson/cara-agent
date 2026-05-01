import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_STORAGE_KEY,
  THEME_STORAGE_KEY,
  createDraftPage,
  createMemoryStorage,
  loadNotebook,
  loadTheme,
  normalizePages,
  removePageById,
  saveNotebook,
  saveTheme,
  updatePageById,
} from "./notebookState.js";

const fallback = [
  {
    id: "home",
    title: "Home",
    section: "Notebook",
    description: "Start",
    updated: "Seeded",
    tone: "plain",
    blocks: [{ type: "paragraph", content: "Hello" }],
    cover: {
      provider: "unsplash",
      id: "cover-1",
      url: "https://images.unsplash.com/photo.jpg",
      thumbUrl: "https://images.unsplash.com/thumb.jpg",
      alt: "A quiet room",
      color: "#262626",
      creditName: "Someone",
      creditUrl: "https://unsplash.com/@someone",
      unsplashUrl: "https://unsplash.com/photos/cover-1",
      downloadLocation: "https://api.unsplash.com/photos/cover-1/download",
      query: "quiet room",
      position: { x: 42, y: 61 },
    },
  },
];

describe("notebook state", () => {
  it("falls back to seeded pages when storage is empty or invalid", () => {
    expect(loadNotebook(fallback, createMemoryStorage())).toEqual(fallback);
    expect(loadNotebook(fallback, createMemoryStorage({ [NOTEBOOK_STORAGE_KEY]: "nope" }))).toEqual(fallback);
  });

  it("saves and reloads notebook pages", () => {
    const storage = createMemoryStorage();
    const pages = [createDraftPage(123)];

    expect(saveNotebook(pages, storage)).toBe(true);
    expect(loadNotebook(fallback, storage)).toEqual(pages);
  });

  it("normalizes partial pages into safe reader pages", () => {
    const pages = normalizePages([
      { id: 99, title: "", blocks: [] },
      {
        id: "old-anchor",
        title: "Anchor",
        cover: {
          provider: "unsplash",
          id: "cover-2",
          url: "https://images.unsplash.com/cover-2.jpg",
          thumbUrl: "javascript:nope",
          alt: "A private notebook",
          creditName: "Unsplash Person",
          creditUrl: "https://unsplash.com/@person",
          downloadLocation: "https://api.unsplash.com/photos/cover-2/download",
          position: { x: 140, y: -10 },
        },
        blocks: [{ type: "paragraph", content: "messages: cara-msg-src-12345" }],
      },
      {
        id: "process",
        section: "System",
        blocks: [{ type: "paragraph", content: "Private machine layer" }],
      },
    ], fallback);

    expect(pages[0].id).toBe("99");
    expect(pages[0].title).toBe("Untitled");
    expect(pages[0].blocks).toEqual([{ type: "paragraph", content: "" }]);
    expect(pages[1].blocks[0].content).toBe("messages: [private source]");
    expect("process" in pages[1]).toBe(false);
    expect(pages[1].cover.url).toBe("https://images.unsplash.com/cover-2.jpg");
    expect(pages[1].cover.thumbUrl).toBe("https://images.unsplash.com/cover-2.jpg");
    expect(pages[1].cover.position).toEqual({ x: 100, y: 0 });
    expect(pages.map((page) => page.id)).not.toContain("process");
  });

  it("persists theme choices", () => {
    const storage = createMemoryStorage({ [THEME_STORAGE_KEY]: "dark" });

    expect(loadTheme(storage)).toBe("dark");
    expect(saveTheme("light", storage)).toBe(true);
    expect(loadTheme(storage)).toBe("light");
  });

  it("fails softly when browser storage is unavailable", () => {
    const brokenStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };

    expect(loadNotebook(fallback, brokenStorage)).toEqual(fallback);
    expect(saveNotebook(fallback, brokenStorage)).toBe(false);
    expect(loadTheme(brokenStorage)).toBe("light");
    expect(saveTheme("dark", brokenStorage)).toBe(false);
  });

  it("updates and removes pages without mutating the rest", () => {
    const pages = [fallback[0], createDraftPage(456)];
    const updated = updatePageById(pages, "home", { title: "Start here" });
    const removed = removePageById(updated, "draft-456");

    expect(updated[0].title).toBe("Start here");
    expect(updated[1].title).toBe("Untitled");
    expect(removed).toHaveLength(1);
    expect(removePageById(removed, "home")).toHaveLength(1);
  });
});
