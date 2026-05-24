import path from "node:path";
import {
  buildZyraPhase2WorkerPrompt,
  buildZyraStage1WorkerPrompt,
  claimZyraPhase2Job,
  completeZyraPhase2Job,
  completeZyraStage1Job,
  completeZyraStage1JobNoOutput,
  ensureZyraMemory,
  failZyraPhase2Job,
  failZyraStage1Job,
  normalizeZyraStage1WorkerOutput,
  parseZyraMemoryWorkerJson,
  prepareZyraCurrentStage1Job,
  prepareZyraMemoryWorkspace,
  prepareZyraPhase2Workspace,
  resetZyraMemoryWorkspaceBaseline,
  runZyraMemoryStartup,
  writeZyraPhase2WorkerOutput,
} from "../zyra-memory.mjs";

const DEFAULT_MODEL = "openai-codex/gpt-5.5";

export function createZyraMemoryRunner(services = {}) {
  const root = path.resolve(services.root ?? process.cwd());
  const runnerServices = { ...services, root };
  return {
    runConsolidation: (runtime, options = {}) => runMemoryConsolidation(runtime, {
      ...options,
      root: path.resolve(options.root ?? root),
    }, runnerServices),
    startBackgroundStartup: (runtime, options = {}) => startMemoryBackgroundStartup(runtime, {
      ...options,
      root: path.resolve(options.root ?? root),
    }, runnerServices),
  };
}

export async function runMemoryConsolidation(runtime, options = {}, services = {}) {
  const root = path.resolve(options.root ?? services.root ?? process.cwd());
  ensureZyraMemory(root);
  prepareZyraMemoryWorkspace(root);
  const previousPrepared = preparedJobsFromStartup(runtime?.memoryStartup);
  const startup = options.skipStartup
    ? { claimed: 0, prepared: [], pruned: [] }
    : runZyraMemoryStartup(root, runtime, {
      maxClaimed: options.maxStartupClaims ?? 2,
      minIdleMinutes: options.minIdleMinutes,
    });
  if (runtime) runtime.memoryStartup = startup;

  const prepared = collectPreparedMemoryJobs([
    ...previousPrepared,
    ...preparedJobsFromStartup(startup),
    ...(options.includeCurrent === false ? [] : [prepareZyraCurrentStage1Job(root, runtime, options.currentJobOptions)]),
  ]);

  const stage1 = {
    considered: prepared.length,
    succeeded: 0,
    noOutput: 0,
    failed: 0,
    skipped: 0,
    threadIds: [],
    errors: [],
  };

  for (const prep of prepared) {
    if (prep.status && prep.status !== "prepared" && prep.status !== "claimed") {
      stage1.skipped += 1;
      continue;
    }
    if (!prep.ownershipToken && !prep.claim?.ownershipToken) {
      stage1.skipped += 1;
      continue;
    }

    const claim = {
      threadId: prep.threadId,
      ownershipToken: prep.ownershipToken ?? prep.claim?.ownershipToken,
    };

    try {
      const rawOutput = await sampleStage1Memory(prep, runtime, options, services);
      const parsed = await parseMemoryWorkerOutput(
        rawOutput,
        ["rollout_summary", "rollout_slug", "raw_memory"],
        runtime,
        options,
        services,
      );
      const normalized = normalizeZyraStage1WorkerOutput(parsed);
      if (normalized.isEmpty) {
        if (completeZyraStage1JobNoOutput(root, claim)) {
          stage1.noOutput += 1;
          stage1.threadIds.push(prep.threadId);
        } else {
          stage1.failed += 1;
          stage1.errors.push(`${prep.threadId}: stale stage-1 claim`);
        }
        continue;
      }

      if (completeZyraStage1Job(root, claim, normalized)) {
        stage1.succeeded += 1;
        stage1.threadIds.push(prep.threadId);
      } else {
        stage1.failed += 1;
        stage1.errors.push(`${prep.threadId}: stale stage-1 claim`);
      }
    } catch (error) {
      failZyraStage1Job(root, claim, error);
      stage1.failed += 1;
      stage1.errors.push(`${prep.threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const phase2 = await runPhase2MemoryWorker(root, runtime, options, services);
  return { root, startup, stage1, phase2 };
}

export function startMemoryBackgroundStartup(runtime, options = {}, services = {}) {
  if (options.disabled || process.env.ZYRA_MEMORY_BACKGROUND === "0") {
    const skipped = Promise.resolve({ skipped: true, reason: "disabled" });
    if (runtime) runtime.memoryBackgroundStartup = skipped;
    return skipped;
  }

  const delayMs = Math.max(0, Number(options.delayMs ?? 1200));
  const task = new Promise((resolve) => {
    setTimeout(() => {
      runMemoryConsolidation(runtime, {
        root: options.root ?? services.root,
        includeCurrent: false,
        maxStartupClaims: options.maxStartupClaims ?? 2,
        minIdleMinutes: options.minIdleMinutes,
        phase2CooldownSeconds: options.phase2CooldownSeconds ?? 0,
      }, services)
        .then(resolve)
        .catch((error) => {
          resolve({
            skipped: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, delayMs);
  });
  if (runtime) runtime.memoryBackgroundStartup = task;
  return task;
}

function collectPreparedMemoryJobs(jobs) {
  const byThreadId = new Map();
  for (const job of jobs) {
    if (!job?.threadId) continue;
    byThreadId.set(job.threadId, job);
  }
  return [...byThreadId.values()];
}

function preparedJobsFromStartup(startup) {
  if (Array.isArray(startup?.preparedJobs)) return startup.preparedJobs;
  if (Array.isArray(startup?.prepared)) return startup.prepared;
  return [];
}

async function sampleStage1Memory(prep, runtime, options, services) {
  const prompt = buildZyraStage1WorkerPrompt(prep);
  if (typeof options.stage1Sampler === "function") {
    return options.stage1Sampler({ prep, runtime, prompt });
  }
  return runInternalZyraMemoryPrompt(runtime, prompt, {
    model: options.stage1Model ?? options.model,
    source: "memory-stage1",
  }, services);
}

async function runPhase2MemoryWorker(root, runtime, options, services) {
  const claim = claimZyraPhase2Job(root, {
    cooldownSeconds: options.phase2CooldownSeconds ?? 0,
    leaseSeconds: options.phase2LeaseSeconds,
    force: options.forcePhase2,
  });
  if (claim.status !== "claimed") {
    return { status: claim.status };
  }

  try {
    const workspace = prepareZyraPhase2Workspace(root, options.phase2WorkspaceOptions);
    if (!workspace.diff.hasChanges) {
      const completed = completeZyraPhase2Job(root, claim, workspace.selectedOutputs);
      return {
        status: completed ? "succeeded_no_workspace_changes" : "failed",
        selected: workspace.selectedOutputs.length,
      };
    }

    const rawOutput = await samplePhase2Memory(root, runtime, options, services);
    const parsed = await parseMemoryWorkerOutput(rawOutput, ["memory_summary", "memory_handbook"], runtime, options, services);
    const write = writeZyraPhase2WorkerOutput(root, parsed);
    resetZyraMemoryWorkspaceBaseline(root);
    const completed = completeZyraPhase2Job(root, claim, write.selectedOutputs);
    return {
      status: completed ? "succeeded" : "failed",
      selected: write.selectedOutputs.length,
      summaryPath: write.summaryPath,
      handbookPath: write.handbookPath,
      skillsWritten: write.skillsWritten,
      skillsDeleted: write.skillsDeleted,
      workspaceDiffPath: workspace.workspaceDiffPath,
    };
  } catch (error) {
    failZyraPhase2Job(root, claim, error);
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function samplePhase2Memory(root, runtime, options, services) {
  const prompt = buildZyraPhase2WorkerPrompt(root, options.phase2PromptOptions);
  if (typeof options.phase2Sampler === "function") {
    return options.phase2Sampler({ root, runtime, prompt });
  }
  return runInternalZyraMemoryPrompt(runtime, prompt, {
    model: options.phase2Model ?? options.model,
    source: "memory-phase2",
  }, services);
}

async function parseMemoryWorkerOutput(rawOutput, requiredKeys, runtime, options = {}, services = {}) {
  if (typeof rawOutput !== "string") return rawOutput;
  try {
    return parseZyraMemoryWorkerJson(rawOutput, requiredKeys);
  } catch (error) {
    if (options.disableRepair) throw error;
    const prompt = buildMemoryJsonRepairPrompt(rawOutput, requiredKeys, error);
    const repaired = typeof options.repairSampler === "function"
      ? await options.repairSampler({ prompt, rawOutput, requiredKeys, error })
      : await runInternalZyraMemoryPrompt(runtime, prompt, {
        model: options.repairModel ?? options.model,
        source: "memory-json-repair",
      }, services);
    return parseZyraMemoryWorkerJson(repaired, requiredKeys);
  }
}

function buildMemoryJsonRepairPrompt(rawOutput, requiredKeys, error) {
  return [
    "Repair this internal Zyra memory worker output.",
    "Return exactly one valid JSON object and nothing else.",
    `Required keys: ${requiredKeys.join(", ")}`,
    `Parser error: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "<broken_output>",
    String(rawOutput ?? "").slice(0, 60000),
    "</broken_output>",
  ].join("\n");
}

async function runInternalZyraMemoryPrompt(runtime, prompt, options = {}, services = {}) {
  if (typeof services.createWorkerSession !== "function") {
    throw new Error("Memory worker session factory is not configured.");
  }
  const worker = await services.createWorkerSession({
    runtime,
    model: options.model ?? selectedRuntimeModel(runtime, services.defaultModel),
    source: options.source ?? "memory-worker",
  });
  const workerSession = worker?.session ?? worker;
  if (!workerSession?.prompt) {
    throw new Error("Memory worker session factory did not return a prompt-capable session.");
  }

  try {
    await workerSession.prompt(prompt, { source: options.source ?? "memory-worker" });
    const lastMessage = workerSession.state?.messages?.at?.(-1);
    if (lastMessage?.role !== "assistant") return "";
    if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
      throw new Error(lastMessage.errorMessage || `Memory worker request ${lastMessage.stopReason}`);
    }
    return extractAssistantText(lastMessage.content);
  } finally {
    await workerSession.dispose?.();
  }
}

function selectedRuntimeModel(runtime, fallback = DEFAULT_MODEL) {
  const model = runtime?.session?.model;
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  return runtime?.model ?? fallback;
}

function extractAssistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
