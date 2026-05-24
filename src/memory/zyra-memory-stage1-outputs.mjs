import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function createMemoryStage1OutputPath(deps) {
  const api = {
    upsertStage1Output(root, output) {
      deps.ensureMemoryWorkspace(root);
      const record = api.upsertStage1OutputWithoutEnsure(root, output, { preserveUsage: true });
      deps.memoryState(root).upsertStage1OutputMetadata(api.stage1Metadata(record));
      deps.rebuildPhase2Inputs(root);
      return record;
    },

    upsertStage1OutputWithoutEnsure(root, output, options = {}) {
      const paths = deps.getMemoryPaths(root);
      mkdirSync(paths.stage1, { recursive: true });
      const now = new Date().toISOString();
      const threadId = sanitizeId(output.threadId ?? output.sessionId ?? "unknown");
      const existing = options.preserveUsage ? api.readStage1Output(root, threadId) : undefined;
      const record = {
        threadId,
        sourcePath: output.sourcePath ? path.resolve(output.sourcePath) : "",
        sourceUpdatedAt: normalizeIso(output.sourceUpdatedAt) ?? now,
        rawMemory: String(output.rawMemory ?? "").trim(),
        rolloutSummary: String(output.rolloutSummary ?? "").trim(),
        rolloutSlug: sanitizeSlug(output.rolloutSlug ?? output.rolloutSummary ?? threadId),
        cwd: output.cwd ? path.resolve(output.cwd) : "",
        gitBranch: output.gitBranch ?? undefined,
        generatedAt: normalizeIso(output.generatedAt) ?? now,
        memoryMode: ["enabled", "disabled", "polluted"].includes(output.memoryMode) ? output.memoryMode : "enabled",
        usageCount: Number.isFinite(output.usageCount) ? output.usageCount : existing?.usageCount ?? 0,
        lastUsage: output.lastUsage ?? existing?.lastUsage,
      };
      writeFileSync(api.stage1File(paths.stage1, threadId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return record;
    },

    readStage1Output(root, threadId) {
      const paths = deps.getMemoryPaths(root);
      const file = api.stage1File(paths.stage1, sanitizeId(threadId));
      if (!existsSync(file)) return undefined;
      return readJsonFile(file);
    },

    listStage1Outputs(root, options = {}) {
      deps.ensureBareMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const state = deps.readMemoryState(root);
      const files = existsSync(paths.stage1)
        ? readdirSync(paths.stage1).filter((file) => file.endsWith(".json")).sort()
        : [];
      const outputs = files
        .map((file) => ({ file, item: readJsonFile(path.join(paths.stage1, file)) }))
        .filter(({ item }) => item)
        .map(({ file, item }) => ({
          ...item,
          threadId: sanitizeId(item.threadId ?? path.basename(item.sourcePath ?? file, ".json")),
        }))
        .filter((item) => !options.enabledOnly || deps.effectiveStage1MemoryMode(state, item) === "enabled");

      const sorted = outputs.sort((left, right) => {
        const usageDelta = (right.usageCount ?? 0) - (left.usageCount ?? 0);
        if (usageDelta) return usageDelta;
        const leftUsage = Date.parse(left.lastUsage ?? left.sourceUpdatedAt ?? left.generatedAt ?? 0) || 0;
        const rightUsage = Date.parse(right.lastUsage ?? right.sourceUpdatedAt ?? right.generatedAt ?? 0) || 0;
        if (rightUsage !== leftUsage) return rightUsage - leftUsage;
        return String(right.sourceUpdatedAt ?? "").localeCompare(String(left.sourceUpdatedAt ?? ""));
      });

      return Number.isFinite(options.limit) ? sorted.slice(0, options.limit) : sorted;
    },

    stage1Metadata(output) {
      return {
        threadId: output.threadId,
        sourcePath: output.sourcePath,
        sourceUpdatedAt: output.sourceUpdatedAt,
        rolloutSlug: output.rolloutSlug,
        cwd: output.cwd,
        gitBranch: output.gitBranch,
        generatedAt: output.generatedAt,
        memoryMode: output.memoryMode ?? "enabled",
        usageCount: output.usageCount ?? 0,
        lastUsage: output.lastUsage,
      };
    },

    syncStateFromStage1Files(root, state) {
      const metadata = api.listStage1Outputs(root).map((output) => api.stage1Metadata(output));
      const runtime = deps.memoryState(root);
      runtime.write(state);
      return runtime.syncStage1OutputMetadata(metadata);
    },

    stage1File(stage1Dir, threadId) {
      return path.join(stage1Dir, `${sanitizeId(threadId)}.json`);
    },

    rolloutSummaryFileName(output) {
      const stamp = compactTimestamp(output.sourceUpdatedAt ?? output.generatedAt);
      const slug = sanitizeSlug(output.rolloutSlug ?? output.rolloutSummary ?? output.threadId).slice(0, 70);
      return `${stamp}-${sanitizeId(output.threadId).slice(0, 8)}${slug ? `-${slug}` : ""}.md`;
    },
  };
  return api;
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sanitizeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function compactTimestamp(value) {
  const date = normalizeIso(value) ?? new Date().toISOString();
  return date.replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
