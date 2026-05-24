import path from "node:path";
import {
  buildMemoryContext,
  buildMemoryOverview,
  forgetMemory,
  formatMemorySources,
  formatSearchResults,
  getThreadMemoryMode,
  listMemorySources,
  readMemoryState,
  rebuildPhase2Inputs,
  resetMemoryWorkspace,
  runMemoryStartup,
  searchMemory,
  setThreadMemoryMode,
} from "./zyra-memory-store.mjs";

const VALID_MEMORY_MODES = new Set(["enabled", "disabled", "polluted"]);

export function createMemoryController({ root, runtime, consolidate } = {}) {
  const memoryRoot = path.resolve(root ?? process.cwd());
  return {
    root: memoryRoot,
    currentThreadId: () => currentThreadId(runtime),
    context: (query = "", options = {}) => buildMemoryContext(memoryRoot, { query, ...options }),
    overview: () => buildMemoryOverview(memoryRoot, { threadId: currentThreadId(runtime) }),
    search: (query, options = {}) => formatSearchResults(searchMemory(memoryRoot, {
      queries: Array.isArray(query) ? query : [query],
      contextLines: options.contextLines ?? 1,
      maxResults: options.maxResults ?? 12,
      normalized: options.normalized ?? true,
      ...options,
    })),
    sources: () => formatMemorySources(listMemorySources(memoryRoot)),
    jobs: () => formatMemoryJobs(readMemoryState(memoryRoot)),
    startup: (options = {}) => {
      const result = runMemoryStartup(memoryRoot, runtime, options);
      if (runtime) runtime.memoryStartup = result;
      return { result, message: formatMemoryStartupResult(result) };
    },
    rebuild: () => {
      const outputs = rebuildPhase2Inputs(memoryRoot);
      return { outputs, message: formatMemoryRebuildResult(outputs) };
    },
    reset: (options = {}) => {
      const result = resetMemoryWorkspace(memoryRoot, options);
      return { result, message: formatMemoryResetResult(result) };
    },
    forgetSource: (threadId) => {
      const ok = forgetMemory(memoryRoot, threadId);
      return { ok, message: ok ? `Memory source disabled: ${threadId}` : `No memory source found: ${threadId}` };
    },
    threadMode: (threadId = currentThreadId(runtime)) => {
      const resolvedThreadId = normalizeThreadId(threadId);
      return {
        threadId: resolvedThreadId,
        mode: getThreadMemoryMode(memoryRoot, resolvedThreadId),
      };
    },
    setThreadMode: (mode, threadId = currentThreadId(runtime)) => {
      const normalizedMode = normalizeMemoryMode(mode);
      const resolvedThreadId = normalizeThreadId(threadId);
      const result = setThreadMemoryMode(memoryRoot, resolvedThreadId, normalizedMode);
      return {
        ...result,
        message: `Memory mode for ${result.threadId}: ${result.mode}`,
      };
    },
    consolidate: async (options = {}) => {
      if (typeof consolidate !== "function") {
        throw new Error("Memory consolidation worker is not configured.");
      }
      return consolidate(runtime, { ...options, root: memoryRoot });
    },
    formatConsolidationResult,
  };
}

export function formatMemoryJobs(state) {
  const lines = ["Memory jobs"];
  const stage1Jobs = Object.values(state.jobs?.memory_stage1 ?? {});
  const phase2Jobs = Object.values(state.jobs?.memory_consolidate_global ?? {});
  if (!stage1Jobs.length && !phase2Jobs.length) {
    lines.push("", "  No memory jobs yet.");
    return lines;
  }
  if (stage1Jobs.length) {
    lines.push("", "Stage 1");
    for (const job of stage1Jobs.slice(0, 20)) {
      lines.push(`  ${job.jobKey}  ${job.status}`);
      lines.push(`    source: ${job.sourcePath ?? "unknown"}`);
      if (job.leaseUntil) lines.push(`    lease: ${job.leaseUntil}`);
      if (job.lastError) lines.push(`    error: ${job.lastError}`);
    }
  }
  if (phase2Jobs.length) {
    lines.push("", "Phase 2");
    for (const job of phase2Jobs) {
      lines.push(`  ${job.jobKey}  ${job.status}`);
      lines.push(`    watermark: ${job.inputWatermark ?? 0}`);
      if (job.leaseUntil) lines.push(`    lease: ${job.leaseUntil}`);
      if (job.lastError) lines.push(`    error: ${job.lastError}`);
    }
  }
  return lines;
}

export function formatMemoryStartupResult(result) {
  return `Memory startup: ${result.claimed ?? 0} claimed, ${result.prepared ?? 0} prepared, ${result.pruned ?? 0} pruned.`;
}

export function formatMemoryRebuildResult(outputs) {
  return `Memory inputs rebuilt: ${outputs.length} source${outputs.length === 1 ? "" : "s"}.`;
}

export function formatMemoryResetResult(result) {
  const parts = [
    `Memory reset: ${result.cleared?.length ?? 0} generated area${result.cleared?.length === 1 ? "" : "s"} cleared`,
    result.preserveAdHoc ? "ad-hoc notes kept" : "ad-hoc notes cleared",
  ];
  if (result.preservedThreadModes) {
    parts.push(`${result.preservedThreadModes} thread mode${result.preservedThreadModes === 1 ? "" : "s"} kept`);
  }
  return `${parts.join(", ")}.`;
}

export function formatConsolidationResult(result) {
  const stage1 = result.stage1 ?? {};
  const phase2 = result.phase2 ?? {};
  const parts = [
    `stage-1 ${stage1.succeeded ?? 0} saved`,
    `${stage1.noOutput ?? 0} no-op`,
    `${stage1.failed ?? 0} failed`,
    `phase-2 ${phase2.status ?? "unknown"}`,
  ];
  if (stage1.skipped) parts.push(`${stage1.skipped} skipped`);
  if (phase2.selected !== undefined) parts.push(`${phase2.selected} selected`);
  if (phase2.skillsWritten) parts.push(`${phase2.skillsWritten} skill${phase2.skillsWritten === 1 ? "" : "s"} written`);
  if (phase2.skillsDeleted) parts.push(`${phase2.skillsDeleted} skill${phase2.skillsDeleted === 1 ? "" : "s"} deleted`);
  if (phase2.error) parts.push(phase2.error);
  return `Memory consolidated: ${parts.join(", ")}.`;
}

function currentThreadId(runtime) {
  return runtime?.session?.sessionManager?.getSessionId?.()
    ?? runtime?.session?.sessionManager?.getSessionFile?.()
    ?? "";
}

function normalizeThreadId(value) {
  const id = path.basename(String(value ?? "").trim(), ".jsonl")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!id) throw new Error("Memory mode requires an active thread.");
  return id;
}

function normalizeMemoryMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!VALID_MEMORY_MODES.has(mode)) {
    throw new Error(`Invalid memory mode: ${value}`);
  }
  return mode;
}
