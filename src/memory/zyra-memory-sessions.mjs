import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { renderSessionForMemory } from "./zyra-memory-prompts.mjs";

export function createMemorySessionPath(deps) {
  return {
    scanMemorySessionSources(project, options = {}) {
      const dirs = [
        options.sessionsDir,
        project ? path.join(path.resolve(project), ".zyra", "sessions") : undefined,
        project ? path.join(path.resolve(project), ".cara", "sessions") : undefined,
      ]
        .filter(Boolean)
        .map((dir) => path.resolve(dir));
      const seen = new Set();
      const sources = [];
      for (const dir of dirs) {
        if (seen.has(dir) || !existsSync(dir)) continue;
        seen.add(dir);
        for (const file of safeReadDir(dir)) {
          if (!file.endsWith(".jsonl")) continue;
          const sourcePath = path.join(dir, file);
          const source = sessionSourceFromFile(sourcePath);
          if (source) sources.push(source);
        }
      }
      return sources.sort((left, right) => Date.parse(right.sourceUpdatedAt) - Date.parse(left.sourceUpdatedAt));
    },

    prepareClaimedStage1Inputs(root, claims, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const prepared = [];
      for (const claim of claims) {
        if (claim.status !== "claimed") continue;
        const sourcePath = claim.source?.sourcePath;
        const snapshot = sourcePath
          ? sessionSnapshotFromFile(sourcePath, { cwd: claim.source?.cwd })
          : undefined;
        if (!snapshot) continue;
        const inputPath = path.join(paths.stage1Inputs, `${claim.threadId}.md`);
        const rendered = renderSessionForMemory(snapshot, { maxChars: options.maxChars ?? 30000 });
        writeFileSync(inputPath, rendered, "utf8");
        deps.updateStage1Job(root, claim.threadId, claim.ownershipToken, {
          inputPath,
          status: "prepared",
          preparedAt: new Date().toISOString(),
        });
        prepared.push({ ...claim, inputPath, rendered });
      }
      return prepared;
    },

    prepareCurrentSessionStage1Job(root, runtime, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const snapshot = runtimeSessionSnapshot(runtime);
      const threadId = sanitizeId(snapshot.sessionId ?? `session-${Date.now()}`);
      const sourceUpdatedAt = snapshot.sourceUpdatedAt ?? new Date().toISOString();
      const source = {
        threadId,
        sourcePath: snapshot.sessionFile ?? "",
        sourceUpdatedAt,
        cwd: snapshot.cwd ?? "",
      };
      const claim = deps.tryClaimStage1Job(root, source, {
        now: options.now,
        leaseSeconds: options.leaseSeconds ?? deps.defaultStage1LeaseSeconds,
        workerId: options.workerId ?? "zyra-current-session",
      });
      if (claim.status !== "claimed") {
        return {
          status: claim.status,
          threadId,
          memoryRoot: paths.root,
          sourcePath: snapshot.sessionFile ?? "",
          sourceUpdatedAt,
          cwd: snapshot.cwd ?? "",
          claim,
        };
      }

      const inputPath = path.join(paths.stage1Inputs, `${threadId}.md`);
      const outputPath = deps.stage1File(paths.stage1, threadId);
      const summaryPath = path.join(paths.rolloutSummaries, `${threadId}.md`);
      const rendered = renderSessionForMemory(snapshot, { maxChars: 30000 });
      writeFileSync(inputPath, rendered, "utf8");
      deps.updateStage1Job(root, threadId, claim.ownershipToken, {
        inputPath,
        status: "prepared",
        preparedAt: new Date().toISOString(),
      });

      return {
        status: "prepared",
        threadId,
        ownershipToken: claim.ownershipToken,
        job: claim.job,
        inputPath,
        outputPath,
        summaryPath,
        memoryRoot: paths.root,
        sourcePath: snapshot.sessionFile ?? "",
        sourceUpdatedAt,
        cwd: snapshot.cwd ?? "",
        rendered,
        claim,
      };
    },
  };
}

function sessionSourceFromFile(sourcePath) {
  if (!existsSync(sourcePath)) return undefined;
  const stat = statSync(sourcePath);
  if (!stat.isFile()) return undefined;
  const header = readSessionHeader(sourcePath);
  const threadId = sanitizeId(header.id ?? sessionIdFromPath(sourcePath));
  if (!threadId) return undefined;
  return {
    threadId,
    sourcePath: path.resolve(sourcePath),
    sourceUpdatedAt: stat.mtime.toISOString(),
    cwd: header.cwd ? path.resolve(header.cwd) : "",
    createdAt: normalizeIso(header.timestamp),
  };
}

function sessionSnapshotFromFile(sourcePath, options = {}) {
  const source = sessionSourceFromFile(sourcePath);
  if (!source) return undefined;
  return {
    sessionId: source.threadId,
    sessionFile: source.sourcePath,
    cwd: options.cwd ?? source.cwd,
    header: readSessionHeader(source.sourcePath),
    entries: readSessionEntries(source.sourcePath),
    sourceUpdatedAt: source.sourceUpdatedAt,
  };
}

function runtimeSessionSnapshot(runtime) {
  const sessionManager = runtime?.session?.sessionManager;
  const sessionFile = sessionManager?.getSessionFile?.();
  const header = sessionFile ? readSessionHeader(sessionFile) : {};
  const entries = Array.isArray(sessionManager?.getEntries?.()) ? sessionManager.getEntries() : readSessionEntries(sessionFile);
  const sessionId = sessionManager?.getSessionId?.() ?? header.id ?? sessionIdFromPath(sessionFile);
  const sourceUpdatedAt = sessionFile && existsSync(sessionFile) ? statSync(sessionFile).mtime.toISOString() : new Date().toISOString();
  return {
    sessionId,
    sessionFile,
    cwd: sessionManager?.getCwd?.() ?? header.cwd ?? runtime?.project,
    header,
    entries,
    sourceUpdatedAt,
  };
}

function readSessionHeader(file) {
  if (!file || !existsSync(file)) return {};
  const first = readText(file).split(/\r?\n/).find(Boolean);
  if (!first) return {};
  try {
    const parsed = JSON.parse(first);
    return parsed?.type === "session" ? parsed : {};
  } catch {
    return {};
  }
}

function readSessionEntries(file) {
  if (!file || !existsSync(file)) return [];
  return readText(file)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function sessionIdFromPath(file) {
  if (!file) return undefined;
  const base = path.basename(file, ".jsonl");
  return base.split("_").at(-1);
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
