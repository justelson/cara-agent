import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const STATE_VERSION = 1;
export const JOB_KIND_STAGE1 = "memory_stage1";
export const JOB_KIND_PHASE2 = "memory_consolidate_global";
export const GLOBAL_PHASE2_JOB_KEY = "global";
export const MEMORY_MODES = new Set(["enabled", "disabled", "polluted"]);

export function createEmptyMemoryState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    stage1Outputs: {},
    jobs: {},
    phase2: {
      selectedThreadIds: [],
      lastInputSyncAt: undefined,
      lastSuccessAt: undefined,
    },
    migrations: {},
    threadMemoryModes: {},
  };
}

export function readMemoryStateFile(file) {
  if (!existsSync(file)) {
    return createEmptyMemoryState();
  }
  try {
    return normalizeMemoryState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    const brokenPath = `${file}.broken-${Date.now()}`;
    writeFileSync(brokenPath, readFileSync(file, "utf8"), "utf8");
    return createEmptyMemoryState();
  }
}

export function writeMemoryStateFile(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const normalized = normalizeMemoryState(state);
  normalized.updatedAt = new Date().toISOString();
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  return normalized;
}

export function mutateMemoryStateFile(file, mutator) {
  const state = readMemoryStateFile(file);
  const result = mutator(state) ?? state;
  return writeMemoryStateFile(file, result);
}

export function createMemoryStateRuntime(stateFile) {
  return {
    read: () => readMemoryStateFile(stateFile),
    write: (state) => writeMemoryStateFile(stateFile, state),

    getThreadMemoryMode(threadId) {
      const id = sanitizeId(threadId);
      if (!id) return "enabled";
      return normalizeStoredMemoryMode(readMemoryStateFile(stateFile).threadMemoryModes?.[id]);
    },

    setThreadMemoryMode(threadId, memoryMode, options = {}) {
      const id = requireThreadId(threadId, "Thread memory mode requires a thread id.");
      const mode = normalizeMemoryMode(memoryMode);
      let result;
      mutateMemoryStateFile(stateFile, (state) => {
        const previousMode = normalizeStoredMemoryMode(state.threadMemoryModes?.[id]);
        const wasSelected = state.phase2.selectedThreadIds?.includes(id);
        const hasStage1Output = Boolean(state.stage1Outputs?.[id]) || Boolean(options.hasStage1Output);
        state.threadMemoryModes[id] = mode;
        result = {
          threadId: id,
          mode,
          previousMode,
          changed: previousMode !== mode,
          needsPhase2Queue: previousMode !== mode && (wasSelected || hasStage1Output),
        };
        return state;
      });
      return result;
    },

    markThreadMemoryModePolluted(threadId, reason = "external context", options = {}) {
      const id = requireThreadId(threadId, "Thread memory pollution requires a thread id.");
      let result;
      mutateMemoryStateFile(stateFile, (state) => {
        const previousMode = normalizeStoredMemoryMode(state.threadMemoryModes?.[id]);
        const wasSelected = state.phase2.selectedThreadIds?.includes(id);
        const hasStage1Output = Boolean(state.stage1Outputs?.[id]) || Boolean(options.hasStage1Output);
        if (previousMode === "polluted") {
          result = { threadId: id, mode: "polluted", previousMode, changed: false, needsPhase2Queue: false, reason };
          return state;
        }
        state.threadMemoryModes[id] = "polluted";
        result = {
          threadId: id,
          mode: "polluted",
          previousMode,
          changed: true,
          needsPhase2Queue: wasSelected || hasStage1Output,
          reason,
        };
        return state;
      });
      return result;
    },

    upsertStage1OutputMetadata(metadata) {
      const threadId = requireThreadId(metadata?.threadId, "Stage-1 metadata requires a thread id.");
      return mutateMemoryStateFile(stateFile, (state) => {
        const sourceMode = normalizeStoredMemoryMode(metadata.memoryMode);
        const threadMode = normalizeStoredMemoryMode(state.threadMemoryModes?.[threadId]);
        state.stage1Outputs[threadId] = { ...metadata, threadId };
        if (!state.phase2.selectedThreadIds.includes(threadId) && sourceMode === "enabled" && threadMode === "enabled") {
          state.phase2.selectedThreadIds.push(threadId);
        }
        return state;
      });
    },

    removeStage1OutputMetadata(threadIds = []) {
      const removed = [];
      const ids = [...new Set(threadIds.map(sanitizeId).filter(Boolean))];
      if (!ids.length) return { removed };
      mutateMemoryStateFile(stateFile, (state) => {
        for (const threadId of ids) {
          if (state.stage1Outputs?.[threadId]) removed.push(threadId);
          delete state.stage1Outputs[threadId];
        }
        state.phase2.selectedThreadIds = (state.phase2.selectedThreadIds ?? []).filter((threadId) => !ids.includes(threadId));
        return state;
      });
      return { removed };
    },

    syncStage1OutputMetadata(metadataList = []) {
      const normalized = metadataList.map((item) => ({ ...item, threadId: sanitizeId(item.threadId) })).filter((item) => item.threadId);
      return mutateMemoryStateFile(stateFile, (state) => {
        state.stage1Outputs = {};
        for (const item of normalized) {
          state.stage1Outputs[item.threadId] = item;
        }
        state.phase2.selectedThreadIds = normalized
          .filter((item) => effectiveStage1MemoryMode(state, item) === "enabled")
          .map((item) => item.threadId);
        return state;
      });
    },

    tryClaimStage1Job(source, options = {}) {
      const now = normalizeIso(options.now) ?? new Date().toISOString();
      const nowMs = Date.parse(now);
      const threadId = requireThreadId(source?.threadId ?? sessionIdFromPath(source?.sourcePath), "Stage-1 job requires a thread id.");
      let claim;
      mutateMemoryStateFile(stateFile, (state) => {
        const threadMemoryMode = normalizeStoredMemoryMode(state.threadMemoryModes?.[threadId]);
        if (threadMemoryMode !== "enabled") {
          claim = { status: `skipped_memory_${threadMemoryMode}`, threadId, memoryMode: threadMemoryMode };
          return state;
        }
        const jobs = state.jobs[JOB_KIND_STAGE1] ?? {};
        const existing = jobs[threadId];
        if (["running", "prepared"].includes(existing?.status) && Date.parse(existing.leaseUntil ?? 0) > nowMs) {
          claim = { status: "skipped_running", threadId };
          return state;
        }
        if (existing?.retryRemaining === 0) {
          claim = { status: "skipped_retry_exhausted", threadId };
          return state;
        }
        if (existing?.retryAt && Date.parse(existing.retryAt) > nowMs) {
          claim = { status: "skipped_retry_backoff", threadId };
          return state;
        }

        const ownershipToken = randomUUID();
        const job = {
          kind: JOB_KIND_STAGE1,
          jobKey: threadId,
          status: "running",
          workerId: options.workerId ?? "zyra-local",
          ownershipToken,
          startedAt: now,
          leaseUntil: new Date(nowMs + Math.max(1, Number(options.leaseSeconds ?? 3600)) * 1000).toISOString(),
          retryRemaining: Number.isFinite(existing?.retryRemaining) ? existing.retryRemaining : Number(options.retryRemaining ?? 3),
          sourcePath: source?.sourcePath ? path.resolve(source.sourcePath) : "",
          sourceUpdatedAt: normalizeIso(source?.sourceUpdatedAt) ?? now,
          cwd: source?.cwd ? path.resolve(source.cwd) : "",
        };
        state.jobs[JOB_KIND_STAGE1] = { ...jobs, [threadId]: job };
        claim = { status: "claimed", threadId, ownershipToken, source: { ...source, threadId }, job };
        return state;
      });
      return claim;
    },

    updateStage1Job(threadId, ownershipToken, patch) {
      const id = sanitizeId(threadId);
      if (!id || !ownershipToken) return false;
      let ok = false;
      mutateMemoryStateFile(stateFile, (state) => {
        const jobs = state.jobs[JOB_KIND_STAGE1] ?? {};
        const job = jobs[id];
        if (!job || job.ownershipToken !== ownershipToken) return state;
        const nextJob = { ...job, ...patch };
        for (const [key, value] of Object.entries(nextJob)) {
          if (value === undefined) delete nextJob[key];
        }
        state.jobs[JOB_KIND_STAGE1] = { ...jobs, [id]: nextJob };
        ok = true;
        return state;
      });
      return ok;
    },

    getStage1JobForToken(threadId, ownershipToken) {
      const id = sanitizeId(threadId);
      const job = readMemoryStateFile(stateFile).jobs[JOB_KIND_STAGE1]?.[id];
      return job && job.ownershipToken === ownershipToken ? job : undefined;
    },

    enqueueGlobalPhase2(inputUpdatedAt) {
      return mutateMemoryStateFile(stateFile, (state) => {
        const jobs = state.jobs[JOB_KIND_PHASE2] ?? {};
        const existing = jobs[GLOBAL_PHASE2_JOB_KEY] ?? {};
        const watermark = Math.max(Number(existing.inputWatermark ?? 0), Date.parse(inputUpdatedAt ?? 0) || Date.now());
        state.jobs[JOB_KIND_PHASE2] = {
          ...jobs,
          [GLOBAL_PHASE2_JOB_KEY]: {
            kind: JOB_KIND_PHASE2,
            jobKey: GLOBAL_PHASE2_JOB_KEY,
            status: existing.status === "running" ? existing.status : "queued",
            retryRemaining: Number.isFinite(existing.retryRemaining) ? existing.retryRemaining : 3,
            inputWatermark: watermark,
            lastSuccessWatermark: existing.lastSuccessWatermark,
            queuedAt: new Date().toISOString(),
            ...(existing.status === "running" ? {
              workerId: existing.workerId,
              ownershipToken: existing.ownershipToken,
              startedAt: existing.startedAt,
              leaseUntil: existing.leaseUntil,
            } : {}),
          },
        };
        return state;
      });
    },

    claimGlobalPhase2Job(inputWatermark, options = {}) {
      const now = normalizeIso(options.now) ?? new Date().toISOString();
      const nowMs = Date.parse(now);
      let claim;
      mutateMemoryStateFile(stateFile, (state) => {
        const jobs = state.jobs[JOB_KIND_PHASE2] ?? {};
        const existing = jobs[GLOBAL_PHASE2_JOB_KEY];
        if (existing?.status === "running" && Date.parse(existing.leaseUntil ?? 0) > nowMs) {
          claim = { status: "skipped_running" };
          return state;
        }
        if (existing?.retryRemaining === 0) {
          claim = { status: "skipped_retry_unavailable" };
          return state;
        }
        if (existing?.retryAt && Date.parse(existing.retryAt) > nowMs) {
          claim = { status: "skipped_retry_unavailable" };
          return state;
        }
        if (existing?.finishedAt && existing.status === "succeeded") {
          const cooldownMs = Math.max(0, Number(options.cooldownSeconds ?? 21600)) * 1000;
          const noNewInputs = Number(existing.lastSuccessWatermark ?? 0) >= inputWatermark;
          if (!options.force && noNewInputs && cooldownMs && nowMs - Date.parse(existing.finishedAt) < cooldownMs) {
            claim = { status: "skipped_cooldown" };
            return state;
          }
        }

        const ownershipToken = randomUUID();
        const job = {
          kind: JOB_KIND_PHASE2,
          jobKey: GLOBAL_PHASE2_JOB_KEY,
          status: "running",
          workerId: options.workerId ?? "zyra-local",
          ownershipToken,
          startedAt: now,
          leaseUntil: new Date(nowMs + Math.max(1, Number(options.leaseSeconds ?? 3600)) * 1000).toISOString(),
          retryRemaining: Number.isFinite(existing?.retryRemaining) ? existing.retryRemaining : Number(options.retryRemaining ?? 3),
          inputWatermark,
          lastSuccessWatermark: existing?.lastSuccessWatermark,
        };
        state.jobs[JOB_KIND_PHASE2] = { ...jobs, [GLOBAL_PHASE2_JOB_KEY]: job };
        claim = { status: "claimed", ownershipToken, inputWatermark, job };
        return state;
      });
      return claim;
    },

    markGlobalPhase2JobSucceeded(claim, selectedThreadIds = [], inputWatermark = claim?.inputWatermark) {
      if (!claim?.ownershipToken) return false;
      let ok = false;
      mutateMemoryStateFile(stateFile, (state) => {
        const job = state.jobs[JOB_KIND_PHASE2]?.[GLOBAL_PHASE2_JOB_KEY];
        if (!job || job.ownershipToken !== claim.ownershipToken) return state;
        const completedAt = new Date().toISOString();
        state.phase2.selectedThreadIds = selectedThreadIds.map(sanitizeId).filter(Boolean);
        state.phase2.lastSuccessAt = completedAt;
        state.phase2.lastSuccessWatermark = inputWatermark;
        state.jobs[JOB_KIND_PHASE2] = {
          ...(state.jobs[JOB_KIND_PHASE2] ?? {}),
          [GLOBAL_PHASE2_JOB_KEY]: {
            ...job,
            status: "succeeded",
            finishedAt: completedAt,
            leaseUntil: undefined,
            lastSuccessWatermark: state.phase2.lastSuccessWatermark,
          },
        };
        ok = true;
        return state;
      });
      return ok;
    },

    markGlobalPhase2JobFailed(claim, error, options = {}) {
      if (!claim?.ownershipToken) return false;
      let ok = false;
      mutateMemoryStateFile(stateFile, (state) => {
        const job = state.jobs[JOB_KIND_PHASE2]?.[GLOBAL_PHASE2_JOB_KEY];
        if (!job || job.ownershipToken !== claim.ownershipToken) return state;
        const retryRemaining = Math.max(0, Number(job.retryRemaining ?? 3) - 1);
        const nowMs = Date.now();
        state.jobs[JOB_KIND_PHASE2][GLOBAL_PHASE2_JOB_KEY] = {
          ...job,
          status: "failed",
          finishedAt: new Date(nowMs).toISOString(),
          leaseUntil: undefined,
          retryRemaining,
          retryAt: retryRemaining > 0
            ? new Date(nowMs + Math.max(1, Number(options.retryDelaySeconds ?? 900)) * 1000).toISOString()
            : undefined,
          lastError: error instanceof Error ? error.message : String(error ?? "phase-2 failed"),
        };
        ok = true;
        return state;
      });
      return ok;
    },
  };
}

export function normalizeMemoryState(value) {
  const state = value && typeof value === "object" ? value : createEmptyMemoryState();
  state.version = STATE_VERSION;
  state.createdAt = state.createdAt ?? new Date().toISOString();
  state.updatedAt = state.updatedAt ?? state.createdAt;
  state.stage1Outputs = state.stage1Outputs && typeof state.stage1Outputs === "object" ? state.stage1Outputs : {};
  state.jobs = normalizeJobs(state.jobs);
  state.phase2 = state.phase2 && typeof state.phase2 === "object" ? state.phase2 : {};
  state.phase2.selectedThreadIds = Array.isArray(state.phase2.selectedThreadIds) ? state.phase2.selectedThreadIds : [];
  state.migrations = state.migrations && typeof state.migrations === "object" ? state.migrations : {};
  state.threadMemoryModes = state.threadMemoryModes && typeof state.threadMemoryModes === "object" ? state.threadMemoryModes : {};
  return state;
}

export function createMemoryResetState(previousState = {}) {
  const previous = normalizeMemoryState(previousState);
  const next = createEmptyMemoryState();
  next.createdAt = previous.createdAt ?? next.createdAt;
  next.threadMemoryModes = { ...(previous.threadMemoryModes ?? {}) };
  next.migrations = { ...(previous.migrations ?? {}) };
  return next;
}

export function normalizeMemoryMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!MEMORY_MODES.has(mode)) {
    throw new Error(`Invalid memory mode: ${value}`);
  }
  return mode;
}

export function normalizeStoredMemoryMode(value) {
  return MEMORY_MODES.has(value) ? value : "enabled";
}

export function effectiveStage1MemoryMode(state, output) {
  const sourceMode = normalizeStoredMemoryMode(output?.memoryMode);
  if (sourceMode !== "enabled") return sourceMode;
  return normalizeStoredMemoryMode(state?.threadMemoryModes?.[sanitizeId(output?.threadId)]);
}

function normalizeJobs(jobs) {
  const normalized = jobs && typeof jobs === "object" ? { ...jobs } : {};
  if (normalized[JOB_KIND_STAGE1]?.jobKey) {
    normalized[JOB_KIND_STAGE1] = {
      [normalized[JOB_KIND_STAGE1].jobKey]: normalized[JOB_KIND_STAGE1],
    };
  }
  if (!normalized[JOB_KIND_STAGE1] || typeof normalized[JOB_KIND_STAGE1] !== "object") {
    normalized[JOB_KIND_STAGE1] = {};
  }
  if (normalized[JOB_KIND_PHASE2]?.kind === JOB_KIND_PHASE2) {
    normalized[JOB_KIND_PHASE2] = {
      [GLOBAL_PHASE2_JOB_KEY]: normalized[JOB_KIND_PHASE2],
    };
  }
  if (!normalized[JOB_KIND_PHASE2] || typeof normalized[JOB_KIND_PHASE2] !== "object") {
    normalized[JOB_KIND_PHASE2] = {};
  }
  return normalized;
}

function requireThreadId(value, message) {
  const id = sanitizeId(value);
  if (!id) throw new Error(message);
  return id;
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sessionIdFromPath(file) {
  if (!file) return undefined;
  const base = path.basename(file, ".jsonl");
  return base.split("_").at(-1);
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
