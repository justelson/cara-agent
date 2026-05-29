import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  renderRawMemories,
  renderRolloutSummary,
} from "./zyra-memory-prompts.mjs";

export function createMemoryWorkspacePath(deps) {
  const api = {
    claimGlobalPhase2Job(root, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const inputWatermark = phase2InputWatermark(root, deps);
      return deps.memoryState(root).claimGlobalPhase2Job(inputWatermark, {
        ...options,
        cooldownSeconds: options.cooldownSeconds ?? deps.defaultPhase2CooldownSeconds,
        leaseSeconds: options.leaseSeconds ?? deps.defaultPhase2LeaseSeconds,
        retryRemaining: deps.defaultRetryRemaining,
      });
    },

    markGlobalPhase2JobSucceeded(root, claim, selectedOutputs) {
      const fallbackOutputs = deps.listStage1Outputs(root, { enabledOnly: true });
      const outputs = api.rebuildPhase2Inputs(root);
      const selected = ((selectedOutputs ?? fallbackOutputs).length ? (selectedOutputs ?? fallbackOutputs) : outputs)
        .map((item) => item.threadId);
      return deps.memoryState(root).markGlobalPhase2JobSucceeded(
        claim,
        selected,
        claim.inputWatermark ?? phase2InputWatermark(root, deps),
      );
    },

    markGlobalPhase2JobFailed(root, claim, error, options = {}) {
      return deps.memoryState(root).markGlobalPhase2JobFailed(claim, error, {
        ...options,
        retryDelaySeconds: options.retryDelaySeconds ?? deps.defaultRetryDelaySeconds,
      });
    },

    prepareMemoryWorkspace(root) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      api.removeMemoryWorkspaceDiff(root);
      ensureGitBaselineRepository(paths.root);
      return paths.root;
    },

    preparePhase2WorkspaceForWorker(root, options = {}) {
      api.prepareMemoryWorkspace(root);
      const selectedOutputs = api.rebuildPhase2Inputs(root, options);
      const diff = api.memoryWorkspaceDiff(root);
      const workspaceDiffPath = diff.hasChanges
        ? api.writeMemoryWorkspaceDiff(root, diff)
        : deps.getMemoryPaths(root).workspaceDiff;
      return {
        selectedOutputs,
        diff,
        workspaceDiffPath,
      };
    },

    memoryWorkspaceDiff(root) {
      const paths = deps.getMemoryPaths(root);
      api.removeMemoryWorkspaceDiff(root);
      ensureGitBaselineRepository(paths.root);
      runGit(paths.root, ["add", "-N", "."], { allowFailure: true });
      const status = runGit(paths.root, ["status", "--porcelain", "--untracked-files=all", "--", "."]).stdout;
      const unifiedDiff = runGit(paths.root, ["diff", "--no-ext-diff", "--binary", "--", "."]).stdout;
      const changes = parseGitStatus(status).filter((change) => change.path !== deps.workspaceDiffFile);
      return {
        hasChanges: changes.length > 0,
        changes,
        unifiedDiff,
      };
    },

    writeMemoryWorkspaceDiff(root, diff) {
      const paths = deps.getMemoryPaths(root);
      writeFileSync(paths.workspaceDiff, renderMemoryWorkspaceDiff(diff, deps.maxWorkspaceDiffBytes), "utf8");
      return paths.workspaceDiff;
    },

    resetMemoryWorkspaceBaseline(root) {
      const paths = deps.getMemoryPaths(root);
      api.removeMemoryWorkspaceDiff(root);
      ensureGitBaselineRepository(paths.root);
      return commitMemoryBaseline(paths.root, "memory baseline");
    },

    resetMemoryWorkspace(root, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const previousState = deps.readMemoryState(root);
      const preserveAdHoc = options.preserveAdHoc !== false;
      const cleared = [];

      for (const dir of [paths.stage1, paths.stage1Inputs, paths.rolloutSummaries, paths.skills]) {
        resetDirectoryInside(paths.root, dir, "memory reset");
        cleared.push(path.relative(paths.root, dir).replaceAll("\\", "/"));
      }

      if (!preserveAdHoc) {
        resetDirectoryInside(paths.root, paths.adHocNotes, "memory reset ad-hoc notes");
        cleared.push(path.relative(paths.root, paths.adHocNotes).replaceAll("\\", "/"));
      }

      for (const file of deps.layerFiles) {
        const target = path.join(paths.root, file);
        assertInsidePath(paths.root, target, "legacy memory reset");
        rmSync(target, { force: true });
      }

      writeFileSync(paths.summary, deps.defaultSummary, "utf8");
      writeFileSync(paths.handbook, deps.defaultHandbook, "utf8");
      writeFileSync(paths.rawMemories, "# Raw Memories\n\nNo raw memories yet.\n", "utf8");
      writeFileSync(paths.workspaceGitignore, deps.memoryWorkspaceGitignore, "utf8");
      writeFileSync(paths.adHocInstructions, deps.adHocInstructions, "utf8");
      api.removeMemoryWorkspaceDiff(root);

      const nextState = deps.createMemoryResetState(previousState);
      deps.writeMemoryState(root, nextState);

      api.rebuildPhase2Inputs(root);
      const baselineCommitted = api.resetMemoryWorkspaceBaseline(root);
      return {
        memoryRoot: paths.root,
        cleared,
        preserveAdHoc,
        preservedThreadModes: Object.keys(nextState.threadMemoryModes).length,
        baselineCommitted,
      };
    },

    removeMemoryWorkspaceDiff(root) {
      rmSync(deps.getMemoryPaths(root).workspaceDiff, { force: true });
    },

    pruneStage1OutputsForRetention(root, options = {}) {
      deps.ensureBareMemoryWorkspace(root);
      const maxUnusedDays = Math.max(1, Number(options.maxUnusedDays ?? 60));
      const limit = clamp(options.limit ?? 100, 1, 1000);
      const cutoff = Date.now() - maxUnusedDays * 24 * 60 * 60 * 1000;
      const state = deps.readMemoryState(root);
      const selected = new Set(state.phase2.selectedThreadIds ?? []);
      const paths = deps.getMemoryPaths(root);
      const pruned = [];
      for (const output of deps.listStage1Outputs(root)) {
        if (pruned.length >= limit) break;
        if (selected.has(output.threadId)) continue;
        const timestamp = Date.parse(output.lastUsage ?? output.sourceUpdatedAt ?? output.generatedAt ?? 0);
        if (!Number.isFinite(timestamp) || timestamp > cutoff) continue;
        rmSync(deps.stage1File(paths.stage1, output.threadId), { force: true });
        delete state.stage1Outputs[output.threadId];
        pruned.push(output.threadId);
      }
      if (pruned.length) {
        deps.writeMemoryState(root, state);
        api.rebuildPhase2Inputs(root);
      }
      return pruned;
    },

    rebuildPhase2Inputs(root, options = {}) {
      deps.ensureBareMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      mkdirSync(paths.rolloutSummaries, { recursive: true });
      deps.writeMemoryState(root, deps.syncStateFromStage1Files(root, deps.readMemoryState(root)));
      const outputs = deps.listStage1Outputs(root, { enabledOnly: true, limit: options.limit ?? 80 });
      const keep = new Set();

      for (const output of outputs) {
        const fileName = deps.rolloutSummaryFileName(output);
        keep.add(fileName);
        writeFileSync(path.join(paths.rolloutSummaries, fileName), renderRolloutSummary(output), "utf8");
      }

      for (const file of safeReadDir(paths.rolloutSummaries)) {
        if (file.endsWith(".md") && !keep.has(file)) {
          rmSync(path.join(paths.rolloutSummaries, file), { force: true });
        }
      }

      writeFileSync(paths.rawMemories, renderRawMemories(outputs, { fileNameForOutput: deps.rolloutSummaryFileName }), "utf8");
      const state = deps.readMemoryState(root);
      state.phase2.selectedThreadIds = outputs.map((item) => item.threadId);
      state.phase2.lastInputSyncAt = new Date().toISOString();
      deps.writeMemoryState(root, state);
      return outputs;
    },
  };
  return api;
}

function phase2InputWatermark(root, deps) {
  return deps.listStage1Outputs(root, { enabledOnly: true }).reduce((max, output) => {
    const updatedAt = Date.parse(output.sourceUpdatedAt ?? output.generatedAt ?? 0) || 0;
    return Math.max(max, updatedAt);
  }, 0);
}

function resetDirectoryInside(parent, target, label) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  if (targetPath === parentPath) {
    throw new Error(`Refusing ${label} at memory root: ${target}`);
  }
  assertInsidePath(parentPath, targetPath, label);
  rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
}

function assertInsidePath(parent, target, label) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  const relative = path.relative(parentPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing ${label} outside expected parent: ${target}`);
  }
}

function ensureGitBaselineRepository(memoryRoot) {
  mkdirSync(memoryRoot, { recursive: true });
  if (!existsSync(path.join(memoryRoot, ".git"))) {
    runGit(memoryRoot, ["init", "-q"]);
  } else {
    const probe = runGit(memoryRoot, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    if (probe.status !== 0 || probe.stdout.trim() !== "true") {
      throw new Error(`Memory workspace git metadata is not usable: ${memoryRoot}`);
    }
  }
  if (!hasGitHead(memoryRoot)) {
    commitMemoryBaseline(memoryRoot, "initial memory baseline");
  }
}

function hasGitHead(memoryRoot) {
  return runGit(memoryRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }).status === 0;
}

function commitMemoryBaseline(memoryRoot, message) {
  runGit(memoryRoot, ["add", "-A", "."]);
  const status = runGit(memoryRoot, ["status", "--porcelain", "--untracked-files=all", "--", "."]).stdout.trim();
  if (!status) return false;
  const result = runGit(memoryRoot, [
    "-c",
    "user.name=Zyra Memory",
    "-c",
    "user.email=zyra-memory@local",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    message,
  ], { allowFailure: true });
  if (result.status === 0) return true;
  if (/nothing to commit|no changes added/i.test(`${result.stdout}\n${result.stderr}`)) return false;
  throw new Error(`git commit failed in memory workspace: ${result.stderr || result.stdout}`);
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const status = result.status ?? (result.error ? 1 : 0);
  const output = {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  if (!options.allowFailure && status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${output.stderr || output.stdout}`);
  }
  return output;
}

function parseGitStatus(status) {
  return String(status ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      return {
        status: gitStatusLabel(code),
        code,
        path: renamePath.replaceAll("\\", "/"),
      };
    });
}

function gitStatusLabel(code) {
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A") || code === "??") return "added";
  if (code.includes("M")) return "modified";
  return "changed";
}

function renderMemoryWorkspaceDiff(diff, maxWorkspaceDiffBytes) {
  const lines = [
    "# Memory Workspace Diff",
    "",
    "Generated by Zyra before Phase 2 memory consolidation. Read this file first and do not edit it.",
    "",
    "## Status",
  ];
  if (!diff?.hasChanges) {
    lines.push("- none");
    return `${lines.join("\n")}\n`;
  }
  for (const change of diff.changes ?? []) {
    lines.push(`- ${change.status} ${change.path}`);
  }
  lines.push("", "## Diff", "", "```diff");
  lines.push(boundedWorkspaceDiff(diff.unifiedDiff ?? "", maxWorkspaceDiffBytes));
  lines.push("```", "");
  return lines.join("\n");
}

function boundedWorkspaceDiff(diff, maxWorkspaceDiffBytes) {
  const text = String(diff ?? "");
  if (text.length <= maxWorkspaceDiffBytes) return text.endsWith("\n") ? text.trimEnd() : text;
  const boundary = previousCharBoundary(text, maxWorkspaceDiffBytes);
  return `${text.slice(0, boundary)}\n\n[workspace diff truncated at ${maxWorkspaceDiffBytes} bytes]`;
}

function previousCharBoundary(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value.length;
  let bytes = 0;
  let index = 0;
  for (const char of value) {
    const nextBytes = bytes + Buffer.byteLength(char, "utf8");
    if (nextBytes > maxBytes) break;
    bytes = nextBytes;
    index += char.length;
  }
  return Math.max(0, index);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
