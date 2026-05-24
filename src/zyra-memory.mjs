import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildConsolidationInstructions,
  buildMemoryOverview as buildStoreMemoryOverview,
  buildMemoryPrompt,
  ensureMemoryWorkspace,
  forgetMemory,
  formatMemorySources,
  formatSearchResults,
  getMemoryPaths,
  listMemorySources,
  readMemoryState,
  rebuildPhase2Inputs,
  searchMemory,
  upsertStage1Output,
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
