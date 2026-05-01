import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = 4547;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(os.tmpdir(), `cara-notes-story-smoke-${process.pid}.sqlite`);
const apiUrl = `http://127.0.0.1:${port}/api/story`;

function cleanupDb() {
  for (const file of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    if (existsSync(file)) unlinkSync(file);
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Story API did not start");
}

async function json(pathname, options = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

cleanupDb();

const server = spawn(process.execPath, ["--no-warnings", "server/story-api.mjs"], {
  cwd: path.resolve(__dirname, ".."),
  env: {
    ...process.env,
    CARA_NOTES_STORY_PORT: String(port),
    CARA_NOTES_STORY_DB: dbPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForServer();

  const initial = await json("/pages");
  if (!initial.pages.some((page) => page.title === "The Room We Kept")) {
    throw new Error("Seed pages did not load");
  }
  if (!initial.pages.some((page) => page.title === "Anam Cara")) {
    throw new Error("Story chapters did not load");
  }
  if (initial.pages.some((page) => ["Daily Notes", "Rhythm", "Boundaries", "Anchors"].includes(page.title))) {
    throw new Error("Report/checklist pages leaked into story DB");
  }
  if (initial.pages.some((page) => page.title === "Process")) {
    throw new Error("Process page leaked into story DB");
  }
  if (initial.pages.some((page) => "process" in page)) {
    throw new Error("Process data leaked into story pages");
  }
  if (initial.pages.some((page) => !page.cover?.url || !page.cover?.position)) {
    throw new Error("Seeded cover metadata did not load");
  }
  const processSide = await json("/process");
  if (!processSide.process?.status?.length) {
    throw new Error("Process side data did not load");
  }
  const coverSearch = await json("/covers?q=quiet%20room");
  if (!coverSearch.covers?.length) {
    throw new Error("Cover search did not return images");
  }

  const nextPages = [
    ...initial.pages,
    {
      id: "smoke-draft",
      title: "Smoke Draft",
      section: "Writing",
      description: "Story DB smoke page.",
      updated: "Smoke",
      tone: "plain",
      cover: {
        provider: "unsplash",
        id: "smoke-cover",
        url: "https://images.unsplash.com/smoke-cover.jpg",
        thumbUrl: "https://images.unsplash.com/smoke-cover-thumb.jpg",
        alt: "Smoke cover",
        creditName: "Smoke Photographer",
        creditUrl: "https://unsplash.com/@smoke",
        downloadLocation: "https://api.unsplash.com/photos/smoke-cover/download",
        position: { x: 33, y: 67 },
      },
      blocks: [{ type: "paragraph", content: "messages: cara-msg-src-12345" }],
      process: [],
    },
  ];

  await json("/pages", {
    method: "PUT",
    body: JSON.stringify({ pages: nextPages }),
  });
  const saved = await json("/pages");
  const smokePage = saved.pages.find((page) => page.id === "smoke-draft");
  if (!smokePage) throw new Error("Smoke page was not saved");
  if (smokePage.blocks[0].content.includes("cara-msg-src")) {
    throw new Error("Private source ID was not scrubbed");
  }
  if (smokePage.cover?.position?.x !== 33 || smokePage.cover?.position?.y !== 67) {
    throw new Error("Cover metadata was not saved");
  }

  const reset = await json("/reset", { method: "POST" });
  if (reset.pages.some((page) => page.id === "smoke-draft")) {
    throw new Error("Reset did not restore seed pages");
  }
  if (reset.pages.some((page) => !page.cover?.url)) {
    throw new Error("Reset did not restore seed covers");
  }

  console.log(JSON.stringify({
    ok: true,
    seededPages: initial.pages.length,
    processSections: processSide.process.status.length,
    coverResults: coverSearch.covers.length,
    savedPages: saved.pages.length,
    resetPages: reset.pages.length,
    dbPath,
  }, null, 2));
} finally {
  if (server.exitCode === null && !server.killed) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  cleanupDb();
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}
