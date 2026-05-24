import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import {
  renderConsolidationInstructions,
  renderPhase2WorkerPrompt,
  renderStage1WorkerPrompt,
} from "./zyra-memory-prompts.mjs";
import { renderSkillsForPrompt } from "./zyra-memory-read.mjs";

export function createMemoryWorkerPromptPath(deps) {
  return {
    buildConsolidationInstructions(root, runtime, globalAgentFiles = []) {
      const prep = deps.prepareMemoryConsolidation(root, runtime);
      const paths = deps.getMemoryPaths(root);
      return renderConsolidationInstructions({ prep, paths, globalAgentFiles });
    },

    buildStage1WorkerPrompt(prep) {
      return renderStage1WorkerPrompt(prep);
    },

    buildPhase2WorkerPrompt(root, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const outputs = deps.rebuildPhase2Inputs(root, options);
      const workspaceDiff = existsSync(paths.workspaceDiff)
        ? readText(paths.workspaceDiff).trim()
        : "# Memory Workspace Diff\n\n## Status\n- not generated\n";
      const skills = renderSkillsForPrompt(paths.skills);
      const rolloutSummaries = safeReadDir(paths.rolloutSummaries)
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => {
          const fullPath = path.join(paths.rolloutSummaries, file);
          return [`## ${file}`, readText(fullPath).trim()].join("\n");
        })
        .join("\n\n---\n\n");

      return renderPhase2WorkerPrompt({
        paths,
        outputs,
        workspaceDiff,
        skills,
        rolloutSummaries,
        summary: readText(paths.summary).trim(),
        handbook: readText(paths.handbook).trim(),
        rawMemories: readText(paths.rawMemories).trim(),
        options,
      });
    },
  };
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
