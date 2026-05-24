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
