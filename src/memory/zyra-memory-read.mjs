import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderMemoryContextPrompt } from "./zyra-memory-prompts.mjs";

export function createMemoryReadPath(deps) {
  return {
    buildMemoryPrompt(root, options = {}) {
      return this.buildMemoryContext(root, options).prompt;
    },

    buildMemoryContext(root, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const query = String(options.query ?? "").trim();
      const summary = readText(paths.summary).trim();
      const summaryExcerpt = summary.slice(0, options.summaryMaxChars ?? 5000);
      const results = query
        ? this.searchMemory(root, { queries: tokenQueries(query), maxResults: 5, contextLines: 1, matchMode: "any" }).matches
        : this.searchMemory(root, { queries: ["reuse_rule", "Current State"], maxResults: 3, contextLines: 1, matchMode: "any" }).matches;

      if (results.length) {
        this.recordMemoryUsage(root, results.map((match) => match.threadId).filter(Boolean));
      }

      const snippets = results.map((match) => {
        const source = `${match.path}:${match.contentStartLineNumber}`;
        return [`Source: ${source}`, match.content.trim()].join("\n");
      });

      const entries = [];
      const summaryLineCount = summaryExcerpt ? summaryExcerpt.split(/\r?\n/).length : 0;
      if (summaryLineCount) {
        entries.push({
          path: path.relative(paths.root, paths.summary).replaceAll("\\", "/"),
          lineStart: 1,
          lineEnd: summaryLineCount,
          note: "prompt-loaded memory summary",
        });
      }
      for (const match of results) {
        entries.push({
          path: match.path,
          lineStart: match.contentStartLineNumber,
          lineEnd: match.contentEndLineNumber,
          note: `retrieved for ${query || "startup context"}`,
        });
      }

      return {
        prompt: renderMemoryContextPrompt({
          root,
          summaryRelativePath: path.relative(root, paths.summary),
          summaryExcerpt,
          snippets,
        }),
        query,
        summaryPath: paths.summary,
        matches: results,
        citation: {
          entries,
          rolloutIds: [...new Set(results.map((match) => match.threadId).filter(Boolean))],
        },
      };
    },

    buildMemoryOverview(root, options = {}) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const state = deps.readMemoryState(root);
      const outputs = deps.listStage1Outputs(root);
      const enabled = deps.listStage1Outputs(root, { enabledOnly: true });
      const summaryBullets = extractBullets(readText(paths.summary)).slice(0, 6);
      const skillNames = listMemorySkillNames(paths.skills);
      const currentThreadId = sanitizeId(options.threadId);
      const lines = ["Zyra memory"];
      lines.push("", "Workspace");
      lines.push(`  Summary: ${path.relative(root, paths.summary)}`);
      lines.push(`  Handbook: ${path.relative(root, paths.handbook)}`);
      lines.push(`  Skills: ${skillNames.length}`);
      lines.push(`  Stage outputs: ${outputs.length}`);
      lines.push(`  Selected for context: ${enabled.length}`);
      lines.push(`  Last sync: ${state.phase2.lastInputSyncAt ?? "never"}`);
      if (currentThreadId) {
        lines.push(`  Current thread: ${currentThreadId} (${deps.getThreadMemoryMode(root, currentThreadId)})`);
      }

      lines.push("", "What is loaded");
      if (summaryBullets.length) {
        for (const bullet of summaryBullets) lines.push(`  ${bullet}`);
      } else {
        lines.push("  No durable summary yet.");
      }

      lines.push("", "Control");
      lines.push("  /memory toggles whether this chat is eligible for future memory logging.");
      return lines;
    },

    searchMemory(root, request = {}) {
      deps.ensureBareMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const queries = (request.queries ?? [])
        .flatMap((query) => String(query).split(/\s+/))
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (!queries.length) {
        return { queries, matches: [], truncated: false };
      }

      const maxResults = clamp(request.maxResults ?? 8, 1, 40);
      const contextLines = clamp(request.contextLines ?? 1, 0, 5);
      const matchMode = request.matchMode ?? "any";
      const files = memorySearchFiles(paths);
      const matches = [];
      for (const file of files) {
        const text = readText(file);
        const lines = text.split(/\r?\n/);
        const relative = path.relative(paths.root, file).replaceAll("\\", "/");
        const threadId = threadIdFromMemoryPath(relative, text);
        for (let idx = 0; idx < lines.length; idx += 1) {
          const haystack = normalizeForSearch(lines[idx], request.normalized);
          const flags = queries.map((query) => haystack.includes(normalizeForSearch(query, request.normalized)));
          const matched = matchMode === "all" ? flags.every(Boolean) : flags.some(Boolean);
          if (!matched) continue;
          const start = Math.max(0, idx - contextLines);
          const end = Math.min(lines.length, idx + contextLines + 1);
          matches.push({
            path: relative,
            threadId,
            matchLineNumber: idx + 1,
            contentStartLineNumber: start + 1,
            contentEndLineNumber: end,
            content: lines.slice(start, end).join("\n"),
            matchedQueries: queries.filter((_, queryIdx) => flags[queryIdx]),
          });
          if (matches.length >= maxResults) {
            return { queries, matches, truncated: true };
          }
        }
      }
      return { queries, matches, truncated: false };
    },

    recordMemoryUsage(root, threadIds = []) {
      const unique = [...new Set(threadIds.map(sanitizeId).filter(Boolean))];
      if (!unique.length) return deps.readMemoryState(root);
      const state = deps.readMemoryState(root);
      const now = new Date().toISOString();
      for (const threadId of unique) {
        const output = deps.readStage1Output(root, threadId);
        if (!output) continue;
        output.usageCount = Number(output.usageCount ?? 0) + 1;
        output.lastUsage = now;
        deps.upsertStage1Output(root, output);
        state.stage1Outputs[threadId] = deps.stage1Metadata(output);
        state.stage1Outputs[threadId].usageCount = output.usageCount;
        state.stage1Outputs[threadId].lastUsage = output.lastUsage;
      }
      return deps.writeMemoryState(root, state);
    },

    listMemorySources(root) {
      deps.ensureMemoryWorkspace(root);
      const state = deps.readMemoryState(root);
      return deps.listStage1Outputs(root).map((output) => ({
        threadId: output.threadId,
        sourcePath: output.sourcePath,
        sourceUpdatedAt: output.sourceUpdatedAt,
        rolloutSummary: output.rolloutSummary,
        cwd: output.cwd,
        memoryMode: deps.effectiveStage1MemoryMode(state, output),
        sourceMemoryMode: output.memoryMode ?? "enabled",
        threadMemoryMode: deps.normalizeStoredMemoryMode(state.threadMemoryModes?.[output.threadId]),
        usageCount: output.usageCount ?? 0,
        lastUsage: output.lastUsage,
      }));
    },

    formatSearchResults,
    formatMemorySources,
  };
}

export function renderSkillsForPrompt(skillsRoot) {
  const files = listMemorySkillFiles(skillsRoot);
  if (!files.length) return "No memory skills yet.";
  return files
    .map((file) => {
      const relative = path.relative(skillsRoot, file).replaceAll("\\", "/");
      return [`## skills/${relative}`, readText(file).trim()].join("\n");
    })
    .join("\n\n---\n\n");
}

export function formatSearchResults(result) {
  const lines = ["Memory search"];
  if (!result.matches.length) {
    lines.push("", "  No matches.");
    return lines;
  }
  for (const match of result.matches) {
    lines.push("", `${match.path}:${match.contentStartLineNumber}`);
    for (const line of match.content.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }
  if (result.truncated) lines.push("", "  More matches exist. Narrow the query.");
  return lines;
}

export function formatMemorySources(sources) {
  const lines = ["Memory sources"];
  if (!sources.length) {
    lines.push("", "  No stage-1 outputs yet.");
    return lines;
  }
  for (const source of sources.slice(0, 30)) {
    lines.push("", `${source.threadId}  ${source.memoryMode ?? "enabled"}`);
    lines.push(`  Updated: ${source.sourceUpdatedAt ?? "unknown"}`);
    lines.push(`  Uses: ${source.usageCount ?? 0}${source.lastUsage ? `, last ${source.lastUsage}` : ""}`);
    if (source.cwd) lines.push(`  Cwd: ${source.cwd}`);
    if (source.rolloutSummary) lines.push(`  ${source.rolloutSummary}`);
  }
  return lines;
}

function memorySearchFiles(paths) {
  const files = [paths.summary, paths.handbook, paths.rawMemories];
  for (const file of safeReadDir(paths.rolloutSummaries)) {
    if (file.endsWith(".md")) files.push(path.join(paths.rolloutSummaries, file));
  }
  files.push(...listMemorySkillFiles(paths.skills));
  return files.filter((file) => existsSync(file));
}

function listMemorySkillFiles(skillsRoot) {
  const files = [];
  for (const skillName of safeReadDir(skillsRoot)) {
    const skillDir = path.join(skillsRoot, skillName);
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) continue;
    collectSkillFiles(skillDir, files);
  }
  return files
    .filter((file) => /\.(md|txt|json|ya?ml|py|js|mjs|sh|ps1)$/i.test(file))
    .sort();
}

function listMemorySkillNames(skillsRoot) {
  return safeReadDir(skillsRoot)
    .filter((skillName) => {
      const skillDir = path.join(skillsRoot, skillName);
      return existsSync(path.join(skillDir, "SKILL.md"));
    })
    .sort();
}

function collectSkillFiles(dir, files) {
  for (const entry of safeReadDir(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = existsSync(fullPath) ? statSync(fullPath) : undefined;
    if (!stat) continue;
    if (stat.isDirectory()) {
      collectSkillFiles(fullPath, files);
    } else if (stat.isFile()) {
      files.push(fullPath);
    }
  }
}

function threadIdFromMemoryPath(relative, text = "") {
  if (!relative.startsWith("rollout_summaries/")) return undefined;
  const explicit = String(text).match(/^thread_id:\s*(.+)$/m)?.[1];
  if (explicit) return sanitizeId(explicit);
  const file = path.basename(relative, ".md");
  const parts = file.split("-");
  return parts.length > 5 ? sanitizeId(parts.slice(5).join("-")) : undefined;
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeForSearch(value, normalized) {
  const text = String(value ?? "").toLowerCase();
  return normalized ? text.replace(/[\\/_.:-]+/g, " ") : text;
}

function tokenQueries(query) {
  const tokens = String(query)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 5);
  return tokens.length ? tokens : [String(query).trim()].filter(Boolean);
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

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function extractBullets(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}
