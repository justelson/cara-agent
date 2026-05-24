#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildConsolidationPrompt,
  buildLayeredMemoryPrompt,
  buildMemoryOverview,
  claimZyraPhase2Job,
  claimZyraStage1Jobs,
  completeZyraPhase2Job,
  completeZyraStage1Job,
  ensureZyraMemory,
  forgetZyraMemory,
  listZyraMemorySources,
  parseZyraMemoryWorkerJson,
  prepareZyraStage1Inputs,
  pruneZyraMemory,
  readZyraMemory,
  rebuildZyraMemory,
  runZyraMemoryStartup,
  scanZyraMemorySessions,
  searchZyraMemory,
  upsertZyraStage1Memory,
} from "../src/zyra-memory.mjs";
import { runZyraMemoryConsolidation } from "../src/zyra-sdk.mjs";

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zyra-memory-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempRootAsync(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zyra-memory-"));
  try {
    return await fn(root);
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

function runMemoryWorkerJsonRegression() {
  const parsed = parseZyraMemoryWorkerJson([
    "```json",
    '{"rollout_summary":"Saved","rollout_slug":"saved","raw_memory":"- durable"}',
    "```",
  ].join("\n"), ["rollout_summary", "rollout_slug", "raw_memory"]);
  assert.equal(parsed.rollout_summary, "Saved");
  assert.throws(
    () => parseZyraMemoryWorkerJson('{"rollout_summary":"Saved"}', ["rollout_summary", "raw_memory"]),
    /missing key: raw_memory/,
  );
}

async function runMemoryWorkerConsolidationRegression() {
  await withTempRootAsync(async (root) => {
    ensureZyraMemory(root);
    const sessionFile = path.join(root, ".zyra", "sessions", "current.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "", "utf8");
    const runtime = {
      root,
      project: root,
      session: {
        sessionManager: {
          getSessionId: () => "current-worker-thread",
          getSessionFile: () => sessionFile,
          getCwd: () => root,
          getEntries: () => [
            {
              type: "message",
              timestamp: "2026-05-24T00:00:00.000Z",
              message: { role: "user", content: "remember that consolidation must be internal, not visible chat" },
            },
            {
              type: "message",
              timestamp: "2026-05-24T00:00:01.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "I will run the memory worker internally." }] },
            },
          ],
        },
      },
    };

    const result = await runZyraMemoryConsolidation(runtime, {
      root,
      skipStartup: true,
      stage1Sampler: async ({ prep, prompt }) => {
        assert.equal(prep.threadId, "current-worker-thread");
        assert.match(prompt, /internal Memory Writing Agent: Phase 1/);
        assert.match(prompt, /consolidation must be internal/);
        return [
          "```json",
          JSON.stringify({
            rollout_summary: "Zyra memory consolidation should run as an internal worker, not a visible chat prompt.",
            rollout_slug: "internal_memory_worker",
            raw_memory: "- For Zyra memory work, `/consolidate` should run an internal worker and keep visible chat clean.",
          }),
          "```",
        ].join("\n");
      },
      phase2Sampler: async ({ prompt }) => {
        assert.match(prompt, /raw_memories\.md/);
        assert.match(prompt, /internal worker/);
        assert.match(prompt, /phase2_workspace_diff\.md/);
        assert.match(prompt, /\+.*internal worker/);
        return {
          memory_summary: "v1\n\n## Zyra Memory\n\n- `/consolidate` runs the internal memory worker path.",
          memory_handbook: "# Zyra Memory\n\nscope: Internal worker regression memory.\n\n- Consolidation is source-backed and not emitted as visible chat.",
        };
      },
    });

    assert.equal(result.stage1.succeeded, 1);
    assert.equal(result.phase2.status, "succeeded");
    assert.equal(listZyraMemorySources(root).some((source) => source.threadId === "current-worker-thread"), true);
    const memory = readZyraMemory(root);
    assert.match(memory.summary, /internal memory worker path/);
    assert.match(memory.handbook, /source-backed/);
    assert.equal(existsSync(path.join(root, ".zyra", "memory", "phase2_workspace_diff.md")), false);
  });
}

async function runMemoryWorkerNoOutputRegression() {
  await withTempRootAsync(async (root) => {
    ensureZyraMemory(root);
    const sessionFile = path.join(root, ".zyra", "sessions", "empty.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "", "utf8");
    const runtime = {
      root,
      project: root,
      session: {
        sessionManager: {
          getSessionId: () => "empty-worker-thread",
          getSessionFile: () => sessionFile,
          getCwd: () => root,
          getEntries: () => [
            {
              type: "message",
              timestamp: "2026-05-24T00:00:00.000Z",
              message: { role: "user", content: "what time is it" },
            },
          ],
        },
      },
    };

    const result = await runZyraMemoryConsolidation(runtime, {
      root,
      skipStartup: true,
      stage1Sampler: async () => ({ rollout_summary: "", rollout_slug: "", raw_memory: "" }),
      phase2Sampler: async () => {
        throw new Error("phase 2 should not run without inputs");
      },
    });

    assert.equal(result.stage1.noOutput, 1);
    assert.equal(result.phase2.status, "succeeded_no_workspace_changes");
    assert.equal(listZyraMemorySources(root).some((source) => source.threadId === "empty-worker-thread"), false);
  });
}

async function runMemoryStartupWorkerSkipsCurrentRegression() {
  await withTempRootAsync(async (root) => {
    ensureZyraMemory(root);
    const sessions = path.join(root, ".zyra", "sessions");
    const oldSession = path.join(sessions, "old.jsonl");
    const currentSession = path.join(sessions, "current.jsonl");
    writeSession(oldSession, {
      id: "old-startup-thread",
      cwd: root,
      updatedAt: "2026-05-20T00:00:00.000Z",
      userText: "remember old startup sessions should run in the background",
    });
    writeSession(currentSession, {
      id: "current-startup-thread",
      cwd: root,
      updatedAt: "2026-05-20T00:00:00.000Z",
      userText: "current live session should not be sampled by startup memory",
    });

    const sampled = [];
    const runtime = {
      root,
      project: root,
      sessions,
      session: {
        sessionManager: {
          getSessionFile: () => currentSession,
          getSessionId: () => "current-startup-thread",
          getCwd: () => root,
          getEntries: () => [],
        },
      },
    };

    const result = await runZyraMemoryConsolidation(runtime, {
      root,
      includeCurrent: false,
      maxStartupClaims: 10,
      minIdleMinutes: 0,
      stage1Sampler: async ({ prep }) => {
        sampled.push(prep.threadId);
        return {
          rollout_summary: "Old startup session captured durable memory.",
          rollout_slug: "old_startup_session",
          raw_memory: "- Background startup memory should process old idle sessions, not the current live session.",
        };
      },
      phase2Sampler: async ({ prompt }) => {
        assert.match(prompt, /phase2_workspace_diff\.md/);
        return {
          memory_summary: "v1\n\n## Zyra Memory\n\n- Background memory startup processes old idle sessions.",
          memory_handbook: "# Zyra Memory\n\nscope: Background memory startup regression.\n\n- Startup memory excludes the current live session.",
        };
      },
    });

    assert.deepEqual(sampled, ["old-startup-thread"]);
    assert.equal(result.stage1.succeeded, 1);
    const sources = listZyraMemorySources(root);
    assert.equal(sources.some((source) => source.threadId === "old-startup-thread"), true);
    assert.equal(sources.some((source) => source.threadId === "current-startup-thread"), false);
  });
}

function runOverviewRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    const overview = buildMemoryOverview(root).join("\n");
    assert.match(overview, /Zyra memory/);
    assert.match(overview, /Stage outputs:/);
    assert.match(overview, /\/memory search <query>/);
    assert.match(overview, /\/memory jobs/);
  });
}

function writeSession(file, { id, cwd, updatedAt, userText = "remember the source-backed flow" }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: updatedAt, cwd }),
    JSON.stringify({
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: updatedAt,
      message: { role: "user", content: userText },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: updatedAt,
      message: { role: "assistant", content: [{ type: "text", text: "I will keep the source." }] },
    }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function runSessionScanAndJobClaimRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    const sessions = path.join(root, ".zyra", "sessions");
    const oldSession = path.join(sessions, "old.jsonl");
    const currentSession = path.join(sessions, "current.jsonl");
    writeSession(oldSession, {
      id: "old-thread",
      cwd: root,
      updatedAt: "2026-05-20T00:00:00.000Z",
      userText: "old memory should be extracted",
    });
    writeSession(currentSession, {
      id: "current-thread",
      cwd: root,
      updatedAt: "2026-05-20T00:00:00.000Z",
      userText: "current memory should be skipped",
    });

    const sources = scanZyraMemorySessions(root, { sessionsDir: sessions });
    assert.equal(sources.some((source) => source.threadId === "old-thread"), true);

    const claims = claimZyraStage1Jobs(root, {
      project: root,
      sessionsDir: sessions,
      currentSessionFile: currentSession,
      now: "2026-05-24T00:00:00.000Z",
      minIdleMinutes: 0,
      maxClaimed: 10,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].threadId, "old-thread");

    const duplicate = claimZyraStage1Jobs(root, {
      project: root,
      sessionsDir: sessions,
      currentSessionFile: currentSession,
      now: "2026-05-24T00:01:00.000Z",
      minIdleMinutes: 0,
      maxClaimed: 10,
    });
    assert.equal(duplicate.length, 0, "leased prepared/running jobs should not be claimed twice");

    const prepared = prepareZyraStage1Inputs(root, claims);
    assert.equal(prepared.length, 1);
    assert.match(readFileSync(prepared[0].inputPath, "utf8"), /old memory should be extracted/);

    assert.equal(completeZyraStage1Job(root, claims[0], {
      rolloutSummary: "Old thread captured durable memory preference.",
      rolloutSlug: "old_thread_memory",
      rawMemory: "- Old session contains reusable memory signal.",
    }), true);
    assert.equal(listZyraMemorySources(root).some((source) => source.threadId === "old-thread"), true);

    const startup = runZyraMemoryStartup(root, {
      project: root,
      sessions,
      session: { sessionManager: { getSessionFile: () => currentSession } },
    }, { minIdleMinutes: 0, maxClaimed: 10 });
    assert.equal(startup.claimed, 0, "startup scan should skip current and up-to-date extracted sessions");
  });
}

function runPhase2LockAndRetentionRegression() {
  withTempRoot((root) => {
    ensureZyraMemory(root);
    upsertZyraStage1Memory(root, {
      threadId: "keep-thread",
      sourcePath: path.join(root, "keep.jsonl"),
      sourceUpdatedAt: "2026-05-23T00:00:00.000Z",
      cwd: root,
      rolloutSummary: "Keep me.",
      rawMemory: "- keep",
    });
    upsertZyraStage1Memory(root, {
      threadId: "stale-thread",
      sourcePath: path.join(root, "stale.jsonl"),
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
      cwd: root,
      rolloutSummary: "Prune me.",
      rawMemory: "- stale",
    });

    let state = readZyraMemory(root).state;
    state.phase2.selectedThreadIds = ["keep-thread"];
    state.stage1Outputs["stale-thread"].lastUsage = "2026-01-01T00:00:00.000Z";
    writeFileSync(path.join(root, ".zyra", "memory", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const claim = claimZyraPhase2Job(root, { now: "2026-05-24T00:00:00.000Z", cooldownSeconds: 0 });
    assert.equal(claim.status, "claimed");
    assert.equal(completeZyraPhase2Job(root, claim), true);
    assert.equal(claimZyraPhase2Job(root, { now: "2026-05-24T00:01:00.000Z" }).status, "skipped_cooldown");

    upsertZyraStage1Memory(root, {
      threadId: "fresh-thread",
      sourcePath: path.join(root, "fresh.jsonl"),
      sourceUpdatedAt: "2026-05-24T00:02:00.000Z",
      cwd: root,
      rolloutSummary: "Fresh input should bypass the old cooldown.",
      rawMemory: "- fresh",
    });
    assert.equal(
      claimZyraPhase2Job(root, { now: "2026-05-24T00:02:01.000Z", cooldownSeconds: 3600 }).status,
      "claimed",
    );

    state = readZyraMemory(root).state;
    state.phase2.selectedThreadIds = ["keep-thread"];
    writeFileSync(path.join(root, ".zyra", "memory", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const pruned = pruneZyraMemory(root, { maxUnusedDays: 30, limit: 10 });
    assert.equal(pruned.includes("stale-thread"), true);
    assert.equal(pruned.includes("keep-thread"), false);
  });
}

runWorkspaceBootstrapRegression();
runStageOutputRetrievalRegression();
runConsolidationPromptRegression();
runMemoryWorkerJsonRegression();
await runMemoryWorkerConsolidationRegression();
await runMemoryWorkerNoOutputRegression();
await runMemoryStartupWorkerSkipsCurrentRegression();
runOverviewRegression();
runSessionScanAndJobClaimRegression();
runPhase2LockAndRetentionRegression();
console.log("zyra-memory regression: ok");
