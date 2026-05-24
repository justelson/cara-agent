import {
  normalizeMemoryMode,
  normalizeStoredMemoryMode,
} from "./zyra-memory-state.mjs";

export function createMemoryModePath(deps) {
  const api = {
    setMemoryMode(root, threadId, memoryMode) {
      const normalizedMode = normalizeMemoryMode(memoryMode);
      const output = deps.readStage1Output(root, threadId);
      if (!output) return false;
      output.memoryMode = normalizedMode;
      deps.upsertStage1Output(root, output);
      return true;
    },

    forgetMemory(root, threadId) {
      return api.setMemoryMode(root, threadId, "disabled");
    },

    getThreadMemoryMode(root, threadId) {
      deps.ensureMemoryWorkspace(root);
      const id = sanitizeId(threadId);
      if (!id) return "enabled";
      const mode = deps.readMemoryState(root).threadMemoryModes?.[id];
      return normalizeStoredMemoryMode(mode);
    },

    setThreadMemoryMode(root, threadId, memoryMode) {
      deps.ensureMemoryWorkspace(root);
      const id = sanitizeId(threadId);
      if (!id) throw new Error("Thread memory mode requires a thread id.");
      const result = deps.memoryState(root).setThreadMemoryMode(id, memoryMode, {
        hasStage1Output: Boolean(deps.readStage1Output(root, id)),
      });
      if (result.needsPhase2Queue) {
        deps.rebuildPhase2Inputs(root);
        deps.memoryState(root).enqueueGlobalPhase2(new Date().toISOString());
      }
      return result;
    },

    markThreadMemoryModePolluted(root, threadId, reason = "external context") {
      deps.ensureMemoryWorkspace(root);
      const id = sanitizeId(threadId);
      if (!id) throw new Error("Thread memory pollution requires a thread id.");
      const result = deps.memoryState(root).markThreadMemoryModePolluted(id, reason, {
        hasStage1Output: Boolean(deps.readStage1Output(root, id)),
      });
      if (result.needsPhase2Queue) {
        deps.rebuildPhase2Inputs(root);
        deps.memoryState(root).enqueueGlobalPhase2(new Date().toISOString());
      }
      return { ...result, phase2Queued: Boolean(result.needsPhase2Queue) };
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
