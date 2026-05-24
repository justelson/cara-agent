import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildConsolidationInstructions,
  buildPhase2WorkerPrompt,
  buildStage1WorkerPrompt,
  buildMemoryOverview as buildStoreMemoryOverview,
  buildMemoryPrompt,
  claimGlobalPhase2Job,
  claimStage1JobsForStartup,
  ensureMemoryWorkspace,
  forgetMemory,
  formatMemorySources,
  formatSearchResults,
  getMemoryPaths,
  listMemorySources,
  markGlobalPhase2JobFailed,
  markGlobalPhase2JobSucceeded,
  markStage1JobFailed,
  markStage1JobSucceeded,
  markStage1JobSucceededNoOutput,
  normalizeStage1WorkerOutput,
  parseMemoryWorkerJson,
  prepareMemoryWorkspace,
  preparePhase2WorkspaceForWorker,
  prepareClaimedStage1Inputs,
  prepareCurrentSessionStage1Job,
  pruneStage1OutputsForRetention,
  readMemoryState,
  rebuildPhase2Inputs,
  resetMemoryWorkspaceBaseline,
  runMemoryStartup,
  searchMemory,
  scanMemorySessionSources,
  upsertStage1Output,
  writePhase2WorkerOutput,
} from "./memory/zyra-memory-store.mjs";

export function ensureZyraMemory(root) {
  return ensureMemoryWorkspace(root);
}

export function readZyraMemory(root) {
  ensureMemoryWorkspace(root);
  const paths = getMemoryPaths(root);
  return {
    root: paths.root,
    state: readMemoryState(root),
    summary: readText(paths.summary),
    handbook: readText(paths.handbook),
    rawMemories: readText(paths.rawMemories),
    sources: listMemorySources(root),
  };
}

export function buildMemoryOverview(root) {
  return buildStoreMemoryOverview(root);
}

export function buildLayeredMemoryPrompt(root, options = {}) {
  return buildMemoryPrompt(root, options);
}

export function buildRecommendedPrompts(root, limit = 1) {
  const paths = getMemoryPaths(root);
  const legacyRecommended = path.join(paths.root, "recommended-prompts.md");
  const candidates = [
    existsSync(legacyRecommended) ? readText(legacyRecommended) : "",
    readText(paths.handbook),
    readText(paths.summary),
  ];
  return candidates
    .flatMap(extractRecommendedPrompts)
    .slice(0, limit);
}

export function buildConsolidationPrompt(runtime, globalAgentFiles = []) {
  return buildConsolidationInstructions(runtime.root, runtime, globalAgentFiles);
}

export function prepareZyraCurrentStage1Job(root, runtime, options = {}) {
  return prepareCurrentSessionStage1Job(root, runtime, options);
}

export function buildZyraStage1WorkerPrompt(prep) {
  return buildStage1WorkerPrompt(prep);
}

export function buildZyraPhase2WorkerPrompt(root, options = {}) {
  return buildPhase2WorkerPrompt(root, options);
}

export function parseZyraMemoryWorkerJson(text, requiredKeys = []) {
  return parseMemoryWorkerJson(text, requiredKeys);
}

export function normalizeZyraStage1WorkerOutput(output) {
  return normalizeStage1WorkerOutput(output);
}

export function writeZyraPhase2WorkerOutput(root, output) {
  return writePhase2WorkerOutput(root, output);
}

export function prepareZyraMemoryWorkspace(root) {
  return prepareMemoryWorkspace(root);
}

export function prepareZyraPhase2Workspace(root, options = {}) {
  return preparePhase2WorkspaceForWorker(root, options);
}

export function resetZyraMemoryWorkspaceBaseline(root) {
  return resetMemoryWorkspaceBaseline(root);
}

export function searchZyraMemory(root, query, options = {}) {
  const queries = Array.isArray(query) ? query : [query];
  return searchMemory(root, { queries, ...options });
}

export function formatZyraMemorySearch(root, query, options = {}) {
  return formatSearchResults(searchZyraMemory(root, query, options));
}

export function listZyraMemorySources(root) {
  return listMemorySources(root);
}

export function formatZyraMemorySources(root) {
  return formatMemorySources(listMemorySources(root));
}

export function forgetZyraMemory(root, threadId) {
  return forgetMemory(root, threadId);
}

export function rebuildZyraMemory(root) {
  return rebuildPhase2Inputs(root);
}

export function upsertZyraStage1Memory(root, output) {
  return upsertStage1Output(root, output);
}

export function runZyraMemoryStartup(root, runtime, options = {}) {
  return runMemoryStartup(root, runtime, options);
}

export function scanZyraMemorySessions(project, options = {}) {
  return scanMemorySessionSources(project, options);
}

export function claimZyraStage1Jobs(root, params = {}) {
  return claimStage1JobsForStartup(root, params);
}

export function prepareZyraStage1Inputs(root, claims, options = {}) {
  return prepareClaimedStage1Inputs(root, claims, options);
}

export function completeZyraStage1Job(root, claim, output) {
  return markStage1JobSucceeded(root, claim, output);
}

export function completeZyraStage1JobNoOutput(root, claim) {
  return markStage1JobSucceededNoOutput(root, claim);
}

export function failZyraStage1Job(root, claim, error, options = {}) {
  return markStage1JobFailed(root, claim, error, options);
}

export function claimZyraPhase2Job(root, options = {}) {
  return claimGlobalPhase2Job(root, options);
}

export function completeZyraPhase2Job(root, claim, selectedOutputs) {
  return markGlobalPhase2JobSucceeded(root, claim, selectedOutputs);
}

export function failZyraPhase2Job(root, claim, error, options = {}) {
  return markGlobalPhase2JobFailed(root, claim, error, options);
}

export function pruneZyraMemory(root, options = {}) {
  return pruneStage1OutputsForRetention(root, options);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function extractRecommendedPrompts(text) {
  const items = [];
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const promptMatch = line.match(/^-\s*(?:Prompt:\s*)?(.+)$/i);
    if (promptMatch) {
      const prompt = promptMatch[1].trim();
      if (/^(still empty|consolidation should|no manual|retrieval-backed)/i.test(prompt)) continue;
      current = { prompt, description: "" };
      items.push(current);
      continue;
    }

    const whyMatch = line.match(/^(?:Why|Description|Reason):\s*(.+)$/i);
    if (whyMatch && current) {
      current.description = whyMatch[1].trim();
    }
  }

  return items
    .map((item) => ({
      prompt: item.prompt.replace(/^["']|["']$/g, "").trim(),
      description: item.description,
    }))
    .filter((item) => item.prompt && !item.prompt.startsWith("#"));
}

export const ensureCaraMemory = ensureZyraMemory;
export const readCaraMemory = readZyraMemory;
