import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MEMORY_DIR = ".cara/memory";
let memoryCache;

const LAYERS = [
  {
    file: "cara-profile.md",
    title: "Cara Profile",
    seed: [
      "# Cara Profile",
      "",
      "- Cara is learning through real code, not school-style theory.",
      "- Treat her as new, not helpless.",
      "- Give her a real seat in the workshop: one clear issue, one next move, one proof.",
      "- Keep friendship boundaries and unresolved archive claims protected when the topic touches the Cara archive.",
    ],
  },
  {
    file: "interaction-rhythm.md",
    title: "Interaction Rhythm",
    seed: [
      "# Interaction Rhythm",
      "",
      "- The useful rhythm is: notice, name, inspect, fix, verify, explain simply.",
      "- When frustration shows up, answer the exact concrete behavior first.",
      "- Avoid turning simple moments into frameworks or lectures.",
      "- Warmth should come from attention and specificity, not filler.",
    ],
  },
  {
    file: "learning-map.md",
    title: "Learning Map",
    seed: [
      "# Learning Map",
      "",
      "- Keep explanations beginner-safe without flattening the real engineering.",
      "- Prefer small observable fixes and runnable checks.",
      "- Track concepts Cara has actually touched before assuming she knows them.",
    ],
  },
  {
    file: "projects-and-tools.md",
    title: "Projects And Tools",
    seed: [
      "# Projects And Tools",
      "",
      "- Cara CLI is a local Pi SDK based coding agent.",
      "- Important surfaces: terminal rendering, slash commands, local sessions, project memory, and archive-grounded safety.",
    ],
  },
  {
    file: "open-loops.md",
    title: "Open Loops",
    seed: [
      "# Open Loops",
      "",
      "- Consolidation should move stable learnings into the right layer and remove stale or duplicated notes.",
      "- The memory system should get more specific as Cara actually uses the CLI.",
    ],
  },
  {
    file: "recommended-prompts.md",
    title: "Recommended Prompts",
    seed: [
      "# Recommended Prompts",
      "",
      "- Prompt: /start",
      "  Why: get a fresh map of this project without reopening an old chat.",
    ],
  },
  {
    file: "consolidation-log.md",
    title: "Consolidation Log",
    seed: [
      "# Consolidation Log",
      "",
      "- No manual consolidation has been recorded yet.",
    ],
  },
];

export function ensureCaraMemory(root) {
  const dir = getMemoryDir(root);
  mkdirSync(dir, { recursive: true });
  for (const layer of LAYERS) {
    const file = path.join(dir, layer.file);
    if (!existsSync(file)) {
      writeFileSync(file, `${layer.seed.join("\n")}\n`, "utf8");
    }
  }
  return readCaraMemory(root);
}

export function readCaraMemory(root) {
  const dir = getMemoryDir(root);
  const signature = memorySignature(dir);
  if (memoryCache?.root === path.resolve(root) && memoryCache.signature === signature) {
    return memoryCache.layers;
  }

  const layers = LAYERS.map((layer) => {
    const file = path.join(dir, layer.file);
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    return { ...layer, path: file, text };
  });
  memoryCache = { root: path.resolve(root), signature, layers };
  return layers;
}

export function buildMemoryOverview(root) {
  const layers = ensureCaraMemory(root);
  const lines = ["What I know about Cara"];
  for (const layer of layers.filter((item) => item.file !== "consolidation-log.md")) {
    const bullets = extractBullets(layer.text).slice(0, 3);
    lines.push("", layer.title);
    if (!bullets.length) {
      lines.push("  Still empty. Consolidation should fill this in from real sessions.");
    } else {
      for (const bullet of bullets) lines.push(`  ${bullet}`);
    }
  }
  lines.push("", "Maintenance");
  lines.push("  Use /consolidate when a session has taught the agent something stable.");
  lines.push("  Consolidation updates the memory layers and may tighten AGENTS.md guidance.");
  return lines;
}

export function buildLayeredMemoryPrompt(root) {
  const layers = ensureCaraMemory(root);
  const sections = layers
    .map((layer) => `File: ${path.relative(root, layer.path)}\n${layer.text.slice(0, 6000)}`)
    .join("\n\n---\n\n");
  return sections.trim();
}

export function buildRecommendedPrompts(root, limit = 1) {
  const layer = ensureCaraMemory(root).find((item) => item.file === "recommended-prompts.md");
  if (!layer) return [];
  return extractRecommendedPrompts(layer.text).slice(0, limit);
}

export function buildConsolidationPrompt(runtime, globalAgentFiles = []) {
  const root = runtime.root;
  const layers = ensureCaraMemory(root);
  const sessionFile = runtime.session.sessionManager.getSessionFile?.();
  const layerList = layers.map((layer) => `- ${layer.title}: ${layer.path}`).join("\n");
  const agentList = globalAgentFiles.length
    ? globalAgentFiles.map((file) => `- ${file}`).join("\n")
    : "- No AGENTS.md files were discovered.";

  return `Consolidate Cara memory now.

This is a manual cleanup pass. Do not dump all memory back into chat. Edit the files directly.

Goal:
- Read the current session context and the existing layered memory.
- Move stable, reusable knowledge about Cara into the correct memory layer.
- Keep raw one-off details out unless they explain a durable pattern.
- Remove duplicates, stale phrasing, and vague filler.
- Keep the memory about how to help Cara learn, how she responds, what overwhelms her, what helps her return, what projects/tools matter, and what boundaries must be preserved.
- Refresh Recommended Prompts with one concrete prompt for the next new chat, based on stable memory and unfinished work, not a raw session dump.
- If the agent behavior guidance itself should change, make a small careful update to the main AGENTS.md guidance file instead of writing a chat essay.

Memory layers:
${layerList}

AGENTS.md guidance files:
${agentList}

Current session file:
${sessionFile ?? "in-memory session only"}

Rules:
- Do not speak as Cara.
- Do not infer hidden intent or score romance.
- Preserve friendship-boundary and unresolved-evidence safety.
- Prefer specific, durable patterns over sentimental copy.
- End with a short consolidation report: files changed, what moved where, and what still needs future evidence.`;
}

function getMemoryDir(root) {
  return path.join(root, MEMORY_DIR);
}

function memorySignature(dir) {
  return LAYERS.map((layer) => {
    const file = path.join(dir, layer.file);
    if (!existsSync(file)) return `${layer.file}:missing`;
    const stat = statSync(file);
    return `${layer.file}:${stat.mtimeMs}:${stat.size}`;
  }).join("|");
}

function extractBullets(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
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
      if (/^(still empty|consolidation should|no manual)/i.test(prompt)) continue;
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
