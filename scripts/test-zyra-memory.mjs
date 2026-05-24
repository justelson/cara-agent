#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildConsolidationPrompt,
  buildLayeredMemoryPrompt,
  buildMemoryOverview,
  ensureZyraMemory,
  forgetZyraMemory,
  listZyraMemorySources,
  readZyraMemory,
  rebuildZyraMemory,
  searchZyraMemory,
  upsertZyraStage1Memory,
} from "../src/zyra-memory.mjs";

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zyra-memory-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runWorkspaceBootstrapRegression() {
  withTempRoot((root) => {
    const legacyDir = path.join(root, ".zyra", "memory");
    const legacyProfile = path.join(legacyDir, "cara-profile.md");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyProfile, "# Cara Profile\n\n- Cara learns through real code.\n", "utf8");

    const state = ensureZyraMemory(root);
    const memoryRoot = path.join(root, ".zyra", "memory");

    assert.equal(state.version, 1);
    assert.equal(existsSync(path.join(memoryRoot, "state.json")), true);
    assert.equal(existsSync(path.join(memoryRoot, "stage1", "legacy-layers.json")), true);
    assert.equal(existsSync(path.join(memoryRoot, "rollout_summaries")), true);
    assert.equal(existsSync(path.join(memoryRoot, "extensions", "ad_hoc", "instructions.md")), true);
    assert.equal(readFileSync(path.join(memoryRoot, "memory_summary.md"), "utf8").startsWith("v1\n"), true);
    assert.match(readFileSync(path.join(memoryRoot, "raw_memories.md"), "utf8"), /Legacy Zyra Memory Layers/);
  });
}

function runStageOutputRetrievalRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    upsertZyraStage1Memory(root, {
      threadId: "thread-a",
      sourcePath: path.join(root, ".zyra", "sessions", "thread-a.jsonl"),
      sourceUpdatedAt: "2026-05-24T00:00:00.000Z",
      cwd: root,
      generatedAt: "2026-05-24T00:01:00.000Z",
      rolloutSlug: "direct_execution_preference",
      rolloutSummary: "Elson prefers direct execution with source-backed proof.",
      rawMemory: [
        "## User preferences",
        "",
        "- Elson prefers direct execution over broad discussion when the repo path is clear.",
        "- Verification should cite the command or file that proves the result.",
      ].join("\n"),
    });

    const rebuilt = rebuildZyraMemory(root);
    assert.equal(rebuilt.some((item) => item.threadId === "thread-a"), true);

    const result = searchZyraMemory(root, "direct execution", { maxResults: 5, normalized: true });
    assert.equal(result.matches.length > 0, true);
    assert.match(result.matches.map((item) => item.content).join("\n"), /direct execution/);

    const prompt = buildLayeredMemoryPrompt(root, { query: "direct execution" });
    assert.match(prompt, /retrieval-backed/);
    assert.match(prompt, /Retrieved memory snippets/);
    assert.match(prompt, /direct execution/);

    assert.equal(forgetZyraMemory(root, "thread-a"), true);
    const sources = listZyraMemorySources(root);
    assert.equal(sources.find((item) => item.threadId === "thread-a")?.memoryMode, "disabled");
  });
}

function runConsolidationPromptRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    const sessionFile = path.join(root, ".zyra", "sessions", "session.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "", "utf8");
    const runtime = {
      root,
      project: root,
      session: {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => sessionFile,
          getCwd: () => root,
          getEntries: () => [
            {
              type: "message",
              timestamp: "2026-05-24T00:00:00.000Z",
              message: { role: "user", content: "remember that memory needs source tracking" },
            },
            {
              type: "message",
              timestamp: "2026-05-24T00:00:01.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "I will wire stage outputs." }] },
            },
          ],
        },
      },
    };

    const prompt = buildConsolidationPrompt(runtime, []);
    const memory = readZyraMemory(root);
    const inputPath = path.join(memory.root, "stage1_inputs", "session-1.md");

    assert.equal(existsSync(inputPath), true);
    assert.match(readFileSync(inputPath, "utf8"), /source tracking/);
    assert.match(prompt, /Phase 1 - extract this session/);
    assert.match(prompt, /Phase 2 - consolidate selected inputs/);
    assert.match(prompt, /memory_summary\.md/);
  });
}

function runOverviewRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    const overview = buildMemoryOverview(root).join("\n");
    assert.match(overview, /Zyra memory/);
    assert.match(overview, /Stage outputs:/);
    assert.match(overview, /\/memory search <query>/);
  });
}

runWorkspaceBootstrapRegression();
runStageOutputRetrievalRegression();
runConsolidationPromptRegression();
runOverviewRegression();
console.log("zyra-memory regression: ok");
