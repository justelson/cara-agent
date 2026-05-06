import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FILE_INDEX_TTL_MS = 4000;
const MAX_INDEX_ENTRIES = 12000;
const MAX_SUGGESTIONS = 20;
const MAX_INLINE_BYTES = 180_000;
const fileIndexCache = new Map();

const ignoredPathParts = new Set([
  ".git",
  "node_modules",
  ".cara/sessions",
  "dist",
  "build",
  ".vite",
  ".cache",
]);

export function getFileMentionSuggestions(runtime, text) {
  const mention = extractActiveFileMention(text);
  if (!mention) return [];

  const project = path.resolve(runtime?.project ?? process.cwd());
  const query = normalizePath(mention.query);
  const entries = getProjectFileIndex(project);
  const scored = entries
    .map((entry) => ({ ...entry, score: scorePath(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || sortFileEntry(a, b))
    .slice(0, MAX_SUGGESTIONS);

  return scored.map((entry) => {
    const value = formatMentionValue(entry.path, mention.quoted);
    return {
      value,
      label: entry.isDirectory ? `${path.posix.basename(entry.path.slice(0, -1))}/` : path.posix.basename(entry.path),
      description: entry.path,
      kind: "file-mention",
      replacementStart: mention.start,
      replacementEnd: text.length,
      isDirectory: entry.isDirectory,
    };
  });
}

export function applyFileMentionSuggestion(text, item) {
  const start = Number.isInteger(item?.replacementStart) ? item.replacementStart : 0;
  const end = Number.isInteger(item?.replacementEnd) ? item.replacementEnd : text.length;
  const suffix = item?.isDirectory ? "" : " ";
  return `${text.slice(0, start)}${item.value}${suffix}${text.slice(end)}`;
}

export function expandFileMentions(runtime, prompt) {
  const project = path.resolve(runtime?.project ?? process.cwd());
  const mentions = collectFileMentionPaths(prompt)
    .map((value) => resolveProjectMention(project, value))
    .filter(Boolean);
  const uniqueMentions = dedupeBy(mentions, (item) => item.absolutePath);
  if (uniqueMentions.length === 0) {
    return { text: prompt, attachedFiles: [] };
  }

  const attachedFiles = [];
  const fileBlocks = [];

  for (const mention of uniqueMentions) {
    const block = readMentionBlock(project, mention.absolutePath);
    if (!block) continue;
    attachedFiles.push(mention.relativePath);
    fileBlocks.push(block);
  }

  if (fileBlocks.length === 0) {
    return { text: prompt, attachedFiles: [] };
  }

  return {
    text: `<attached_files>\n${fileBlocks.join("\n")}\n</attached_files>\n\nUser prompt:\n${prompt}`,
    attachedFiles,
  };
}

function extractActiveFileMention(text) {
  const quoteStart = text.lastIndexOf('@"');
  if (quoteStart >= 0 && isTokenStart(text, quoteStart)) {
    const rest = text.slice(quoteStart + 2);
    if (!rest.includes('"')) {
      return {
        start: quoteStart,
        query: rest,
        quoted: true,
      };
    }
  }

  const tokenStart = lastTokenStart(text);
  const token = text.slice(tokenStart);
  if (!token.startsWith("@") || token.includes('"')) return null;

  return {
    start: tokenStart,
    query: token.slice(1),
    quoted: false,
  };
}

function collectFileMentionPaths(text) {
  const results = [];
  const pattern = /(^|\s)@(?:"([^"]+)"|([^\s"]+))/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[2] ?? match[3];
    if (value) results.push(value);
  }
  return results;
}

function resolveProjectMention(project, mentionPath) {
  const normalized = normalizePath(mentionPath).replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const absolutePath = path.resolve(project, normalized);
  const relativePath = normalizePath(path.relative(project, absolutePath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  if (!existsSync(absolutePath)) return null;
  return { absolutePath, relativePath };
}

function readMentionBlock(project, absolutePath) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const relativePath = normalizePath(path.relative(project, absolutePath));
  if (stats.size > MAX_INLINE_BYTES) {
    return `<file name="${escapeAttribute(relativePath)}">[File omitted: ${stats.size.toLocaleString("en-US")} bytes is too large to inline.]</file>`;
  }

  try {
    const buffer = readFileSync(absolutePath);
    if (isLikelyBinary(buffer)) {
      return `<file name="${escapeAttribute(relativePath)}">[File omitted: binary or non-text content.]</file>`;
    }
    const content = buffer.toString("utf8");
    return `<file name="${escapeAttribute(relativePath)}">\n${content}\n</file>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<file name="${escapeAttribute(relativePath)}">[File omitted: ${message}]</file>`;
  }
}

function getProjectFileIndex(project) {
  const cached = fileIndexCache.get(project);
  if (cached && Date.now() - cached.createdAt < FILE_INDEX_TTL_MS) {
    return cached.entries;
  }

  const entries = buildProjectFileIndex(project).slice(0, MAX_INDEX_ENTRIES);
  fileIndexCache.set(project, {
    createdAt: Date.now(),
    entries,
  });
  return entries;
}

function buildProjectFileIndex(project) {
  const rgEntries = readProjectFilesWithRg(project);
  const files = rgEntries.length > 0 ? rgEntries : readProjectFilesWithFs(project);
  const directories = new Set();

  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      directories.add(`${parts.slice(0, i).join("/")}/`);
    }
  }

  return [
    ...[...directories].map((entryPath) => ({ path: entryPath, isDirectory: true })),
    ...files.map((entryPath) => ({ path: entryPath, isDirectory: false })),
  ].filter((entry) => !isIgnoredPath(entry.path));
}

function readProjectFilesWithRg(project) {
  const result = spawnSync(
    "rg",
    [
      "--files",
      "--hidden",
      "-g",
      "!.git/**",
      "-g",
      "!node_modules/**",
      "-g",
      "!.cara/sessions/**",
      "-g",
      "!dist/**",
      "-g",
      "!build/**",
      "-g",
      "!.vite/**",
      "-g",
      "!.cache/**",
    ],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean)
    .filter((entryPath) => !isIgnoredPath(entryPath));
}

function readProjectFilesWithFs(project) {
  const files = [];
  walk(project, "");
  return files;

  function walk(root, relativeRoot) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeRoot, entry.name));
      if (isIgnoredPath(relativePath)) continue;
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
      if (files.length >= MAX_INDEX_ENTRIES) return;
    }
  }
}

function scorePath(entry, query) {
  if (!query) {
    return entry.isDirectory ? 12 - pathDepth(entry.path) : 8 - pathDepth(entry.path);
  }

  const candidate = entry.path.toLowerCase();
  const basename = path.posix.basename(entry.isDirectory ? entry.path.slice(0, -1) : entry.path).toLowerCase();
  const q = query.toLowerCase();

  if (candidate === q || candidate === `${q}/`) return 120;
  if (basename === q) return entry.isDirectory ? 115 : 110;
  if (candidate.startsWith(q)) return entry.isDirectory ? 95 : 90;
  if (basename.startsWith(q)) return entry.isDirectory ? 85 : 80;
  if (basename.includes(q)) return entry.isDirectory ? 65 : 60;
  if (candidate.includes(q)) return entry.isDirectory ? 45 : 40;
  if (fuzzyIncludes(candidate, q)) return entry.isDirectory ? 25 : 20;
  return 0;
}

function sortFileEntry(a, b) {
  if (a.isDirectory && !b.isDirectory) return -1;
  if (!a.isDirectory && b.isDirectory) return 1;
  return a.path.localeCompare(b.path);
}

function fuzzyIncludes(candidate, query) {
  let cursor = 0;
  for (const char of query) {
    cursor = candidate.indexOf(char, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

function formatMentionValue(entryPath, forceQuoted = false) {
  const mention = `@${entryPath}`;
  if (!forceQuoted && !/\s/.test(entryPath)) return mention;
  return `@"${entryPath.replaceAll('"', '\\"')}"`;
}

function lastTokenStart(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(text[index])) return index + 1;
  }
  return 0;
}

function isTokenStart(text, index) {
  return index === 0 || /\s/.test(text[index - 1]);
}

function isIgnoredPath(value) {
  const normalized = normalizePath(value);
  return [...ignoredPathParts].some((part) => normalized === part || normalized.startsWith(`${part}/`));
}

function pathDepth(value) {
  return normalizePath(value).split("/").filter(Boolean).length;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return true;
  const text = sample.toString("utf8");
  return text.includes("\uFFFD");
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
