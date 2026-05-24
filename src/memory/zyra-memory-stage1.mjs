import path from "node:path";

export function createMemoryStage1Path(deps) {
  const api = {
    claimStage1JobsForStartup(root, params = {}) {
      deps.ensureMemoryWorkspace(root);
      const nowMs = Date.parse(params.now ?? new Date().toISOString());
      const scanLimit = clamp(params.scanLimit ?? 50, 1, 500);
      const maxClaimed = clamp(params.maxClaimed ?? 3, 0, 50);
      if (maxClaimed === 0) return [];

      const maxAgeMs = Math.max(0, Number(params.maxAgeDays ?? 45)) * 24 * 60 * 60 * 1000;
      const minIdleMs = Math.max(0, Number(params.minIdleMinutes ?? 15)) * 60 * 1000;
      const currentSessionFile = params.currentSessionFile ? path.resolve(params.currentSessionFile) : "";
      const sources = (params.sources ?? deps.scanMemorySessionSources(params.project ?? root, { sessionsDir: params.sessionsDir }))
        .slice(0, scanLimit);
      const claims = [];

      for (const source of sources) {
        if (claims.length >= maxClaimed) break;
        const sourcePath = path.resolve(source.sourcePath);
        if (currentSessionFile && sourcePath.toLowerCase() === currentSessionFile.toLowerCase()) continue;
        const sourceUpdatedAtMs = Date.parse(source.sourceUpdatedAt);
        if (!Number.isFinite(sourceUpdatedAtMs)) continue;
        if (maxAgeMs && nowMs - sourceUpdatedAtMs > maxAgeMs) continue;
        if (minIdleMs && nowMs - sourceUpdatedAtMs < minIdleMs) continue;

        const threadId = sanitizeId(source.threadId);
        if (deps.memoryState(root).getThreadMemoryMode(threadId) !== "enabled") continue;
        const existing = deps.readStage1Output(root, threadId);
        if (existing && Date.parse(existing.sourceUpdatedAt) >= sourceUpdatedAtMs) continue;

        const claim = api.tryClaimStage1Job(root, source, {
          now: new Date(nowMs).toISOString(),
          leaseSeconds: params.leaseSeconds ?? deps.defaultStage1LeaseSeconds,
        });
        if (claim.status === "claimed") claims.push(claim);
      }

      return claims;
    },

    tryClaimStage1Job(root, source, options = {}) {
      deps.ensureMemoryWorkspace(root);
      return deps.memoryState(root).tryClaimStage1Job(source, {
        ...options,
        leaseSeconds: options.leaseSeconds ?? deps.defaultStage1LeaseSeconds,
        retryRemaining: deps.defaultRetryRemaining,
      });
    },

    markStage1JobSucceeded(root, claim, output) {
      const job = api.getStage1JobForToken(root, claim.threadId, claim.ownershipToken);
      if (!job) return false;
      const record = deps.upsertStage1Output(root, {
        ...output,
        threadId: claim.threadId,
        sourcePath: output.sourcePath ?? job.sourcePath,
        sourceUpdatedAt: output.sourceUpdatedAt ?? job.sourceUpdatedAt,
        cwd: output.cwd ?? job.cwd,
      });
      api.updateStage1Job(root, claim.threadId, claim.ownershipToken, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        leaseUntil: undefined,
        outputPath: deps.stage1File(deps.getMemoryPaths(root).stage1, claim.threadId),
        lastError: undefined,
      });
      api.enqueuePhase2Job(root, record.sourceUpdatedAt);
      return true;
    },

    markStage1JobSucceededNoOutput(root, claim) {
      const job = api.getStage1JobForToken(root, claim.threadId, claim.ownershipToken);
      if (!job) return false;
      api.updateStage1Job(root, claim.threadId, claim.ownershipToken, {
        status: "succeeded_no_output",
        finishedAt: new Date().toISOString(),
        leaseUntil: undefined,
        lastError: undefined,
      });
      return true;
    },

    markStage1JobFailed(root, claim, error, options = {}) {
      const job = api.getStage1JobForToken(root, claim.threadId, claim.ownershipToken);
      if (!job) return false;
      const nowMs = Date.now();
      const retryRemaining = Math.max(0, Number(job.retryRemaining ?? deps.defaultRetryRemaining) - 1);
      api.updateStage1Job(root, claim.threadId, claim.ownershipToken, {
        status: "failed",
        finishedAt: new Date(nowMs).toISOString(),
        leaseUntil: undefined,
        retryRemaining,
        retryAt: retryRemaining > 0
          ? new Date(nowMs + Math.max(1, Number(options.retryDelaySeconds ?? deps.defaultRetryDelaySeconds)) * 1000).toISOString()
          : undefined,
        lastError: error instanceof Error ? error.message : String(error ?? "stage-1 failed"),
      });
      return true;
    },

    runMemoryStartup(root, runtime, options = {}) {
      const project = options.project ?? runtime?.project ?? root;
      const currentSessionFile = runtime?.session?.sessionManager?.getSessionFile?.();
      const claims = api.claimStage1JobsForStartup(root, {
        project,
        sessionsDir: options.sessionsDir ?? runtime?.sessions,
        currentSessionFile,
        scanLimit: options.scanLimit,
        maxClaimed: options.maxClaimed,
        maxAgeDays: options.maxAgeDays,
        minIdleMinutes: options.minIdleMinutes,
        leaseSeconds: options.leaseSeconds,
      });
      const prepared = deps.prepareClaimedStage1Inputs(root, claims, options);
      const pruned = deps.pruneStage1OutputsForRetention(root, {
        maxUnusedDays: options.maxUnusedDays ?? 60,
        limit: options.pruneLimit ?? 100,
      });
      return {
        claimed: claims.length,
        prepared: prepared.length,
        pruned: pruned.length,
        claims,
        preparedJobs: prepared,
        prunedThreadIds: pruned,
      };
    },

    updateStage1Job(root, threadId, ownershipToken, patch) {
      return deps.memoryState(root).updateStage1Job(threadId, ownershipToken, patch);
    },

    getStage1JobForToken(root, threadId, ownershipToken) {
      return deps.memoryState(root).getStage1JobForToken(threadId, ownershipToken);
    },

    enqueuePhase2Job(root, inputUpdatedAt) {
      deps.memoryState(root).enqueueGlobalPhase2(inputUpdatedAt);
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}
