import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeOpeningTheme, pickOpeningTheme } from "./banner.mjs";
import { buildConsolidationPrompt, buildLayeredMemoryPrompt, buildMemoryOverview, ensureCaraMemory } from "./cara-memory.mjs";

const PI_ROOT = path.resolve("C:/Users/elson/my_coding_play/play projects/pi");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARA_THEME_CUSTOM_TYPE = "cara.theme.v1";
const CARA_EXIT_CUSTOM_TYPE = "cara.exit.v1";
const CARA_PROJECT_MEMORY_MARKER = "CARA_PROJECT_MEMORY";
const CARA_LAYERED_MEMORY_MARKER = "CARA_LAYERED_MEMORY";
const CARA_PROFILE_CUSTOM_TYPE = "cara.profile.v1";
const CARA_PROFILE_MARKER = "CARA_ACTIVE_PROFILE";

export const defaults = {
  piRoot: PI_ROOT,
  root: ROOT,
  project: path.resolve(process.env.CARA_CALLER_CWD ?? process.cwd()),
  prompt: path.join(ROOT, "prompts/cara-level1.md"),
  inspectPrompt: path.join(ROOT, "prompts/inspect-project.md"),
  thinking: "medium",
  model: "openai-codex/gpt-5.5",
};

export function getProjectSessionsDir(project = defaults.project) {
  return path.join(path.resolve(project), ".cara", "sessions");
}

async function importPiSource(relativePath) {
  const file = path.join(PI_ROOT, relativePath);
  return import(pathToFileURL(file).href);
}

async function loadPiSessionManager() {
  const { SessionManager } = await importPiSource("packages/coding-agent/src/core/session-manager.ts");
  return SessionManager;
}

function readPrompt(file) {
  return readFileSync(file, "utf8").trim();
}

function injectCaraGuide(session, guide) {
  const marker = "CARA_LEVEL_1_GUIDE";
  const addition = `\n\n<${marker}>\n${guide}\n</${marker}>`;
  const currentBase = session._baseSystemPrompt ?? session.agent.state.systemPrompt ?? "";
  session._baseSystemPrompt = currentBase.includes(`<${marker}>`)
    ? currentBase.replace(new RegExp(`\\n\\n<${marker}>[\\s\\S]*?</${marker}>`), addition)
    : `${currentBase}${addition}`;
  session.agent.state.systemPrompt = session._baseSystemPrompt;
}

export async function createCaraSession(options = {}) {
  const project = path.resolve(options.project ?? defaults.project);
  const sessions = path.resolve(options.sessions ?? getProjectSessionsDir(project));
  const thinking = options.thinking ?? defaults.thinking;

  if (!existsSync(project)) {
    throw new Error(`Project path does not exist: ${project}`);
  }
  if (!existsSync(defaults.prompt)) {
    throw new Error(`Cara guide is missing: ${defaults.prompt}`);
  }

  mkdirSync(sessions, { recursive: true });

  const [{ createAgentSession }, SessionManager] = await Promise.all([
    importPiSource("packages/coding-agent/src/core/sdk.ts"),
    loadPiSessionManager(),
  ]);

  const sessionManager = await createSessionManager(SessionManager, {
    project,
    sessions,
    mode: options.sessionMode,
    selector: options.session,
    noSession: options.noSession,
  });
  const theme = ensureSessionTheme(sessionManager, { persist: !options.noSession });
  const profile = ensureSessionProfile(sessionManager, { persist: !options.noSession, requested: options.profile });
  const result = await createAgentSession({
    cwd: sessionManager.getCwd?.() ?? project,
    sessionManager,
    thinkingLevel: thinking,
    sessionStartEvent: { type: "session_start", reason: options.sessionMode === "continue" || options.session ? "resume" : "new" },
  });

  injectCaraGuide(result.session, readPrompt(defaults.prompt));
  ensureCaraMemory(ROOT);
  injectLayeredMemory(result.session, ROOT);
  injectActiveProfile(result.session, profile);
  const projectMemory = injectProjectMemory(result.session, project);

  await preferDefaultModel(result.session, options.model ?? defaults.model);

  return {
    session: result.session,
    root: ROOT,
    project,
    sessions,
    theme,
    profile,
    projectMemory,
    thinking,
    modelFallbackMessage: result.modelFallbackMessage,
  };
}

async function createSessionManager(SessionManager, options) {
  if (options.noSession) {
    return SessionManager.inMemory(options.project);
  }

  if (options.selector) {
    const sessionPath = await resolveCaraSessionPath({
      project: options.project,
      sessions: options.sessions,
      selector: options.selector,
    });
    return SessionManager.open(sessionPath, options.sessions);
  }

  if (options.mode === "continue") {
    return SessionManager.continueRecent(options.project, options.sessions);
  }

  return SessionManager.create(options.project, options.sessions);
}

export async function listCaraSessions(options = {}) {
  const project = path.resolve(options.project ?? defaults.project);
  const sessions = path.resolve(options.sessions ?? getProjectSessionsDir(project));
  const SessionManager = await loadPiSessionManager();
  return SessionManager.list(project, sessions);
}

export async function resolveCaraSessionPath(options = {}) {
  const project = path.resolve(options.project ?? defaults.project);
  const sessions = path.resolve(options.sessions ?? getProjectSessionsDir(project));
  const selector = String(options.selector ?? "").trim();
  if (!selector) {
    throw new Error("Choose a chat id from `cara sessions`, or pass a session file path.");
  }

  if (looksLikePath(selector)) {
    const sessionPath = path.isAbsolute(selector) ? selector : path.resolve(project, selector);
    if (!existsSync(sessionPath)) {
      throw new Error(`Session file does not exist: ${sessionPath}`);
    }
    return sessionPath;
  }

  const matches = (await listCaraSessions({ project, sessions })).filter((session) => session.id.startsWith(selector));
  if (matches.length === 0) {
    throw new Error(`No local chat matches: ${selector}`);
  }
  if (matches.length > 1) {
    const ids = matches.slice(0, 5).map((session) => session.id.slice(0, 8)).join(", ");
    throw new Error(`Chat id is ambiguous: ${selector}. Matches: ${ids}`);
  }
  return matches[0].path;
}

function looksLikePath(value) {
  return value.endsWith(".jsonl") || value.includes("/") || value.includes("\\") || path.isAbsolute(value);
}

function ensureSessionTheme(sessionManager, options = {}) {
  const stored = readSessionTheme(sessionManager);
  if (stored) return stored;
  const theme = pickOpeningTheme();
  if (options.persist && typeof sessionManager.appendCustomEntry === "function") {
    sessionManager.appendCustomEntry(CARA_THEME_CUSTOM_TYPE, theme);
  }
  return theme;
}

function readSessionTheme(sessionManager) {
  const entries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === CARA_THEME_CUSTOM_TYPE) {
      return normalizeOpeningTheme(entry.data);
    }
  }
  return undefined;
}

function ensureSessionProfile(sessionManager, options = {}) {
  const requested = normalizeProfile(options.requested);
  const stored = readSessionProfile(sessionManager);
  const profile = requested && requested !== "auto" ? requested : stored ?? detectDefaultProfile();
  if (options.persist && typeof sessionManager.appendCustomEntry === "function" && !stored) {
    sessionManager.appendCustomEntry(CARA_PROFILE_CUSTOM_TYPE, {
      profile,
      source: requested && requested !== "auto" ? "manual" : "auto",
      savedAt: new Date().toISOString(),
    });
  }
  return profile;
}

function readSessionProfile(sessionManager) {
  const entries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === CARA_PROFILE_CUSTOM_TYPE) {
      return normalizeProfile(entry.data?.profile);
    }
  }
  return undefined;
}

function detectDefaultProfile() {
  const envProfile = normalizeProfile(process.env.CARA_PROFILE);
  if (envProfile && envProfile !== "auto") return envProfile;
  const username = String(os.userInfo().username ?? process.env.USERNAME ?? process.env.USER ?? "").toLowerCase();
  const homeName = path.basename(os.homedir() || "").toLowerCase();
  return username === "elson" || homeName === "elson" ? "elson" : "cara";
}

function normalizeProfile(value) {
  const profile = String(value ?? "").trim().toLowerCase();
  if (!profile) return undefined;
  return ["elson", "cara", "auto"].includes(profile) ? profile : undefined;
}

async function preferDefaultModel(session, selector) {
  const [provider, ...modelParts] = String(selector ?? "").split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) return;
  if (session.model?.provider === provider && session.model?.id === modelId) return;

  const model = session.modelRegistry.find(provider, modelId);
  if (!model || !session.modelRegistry.hasConfiguredAuth(model)) return;
  await session.setModel(model);
}

export async function runCaraPrompt(runtime, prompt, options = {}) {
  await runtime.session.prompt(prompt, { source: "interactive", images: options.images });
}

export function describeRuntime(runtime) {
  const model = runtime.session.model;
  const sessionManager = runtime.session.sessionManager;
  const usage = calculateSessionUsage(sessionManager);
  return {
    project: runtime.project,
    sessions: runtime.sessions,
    theme: runtime.theme,
    profile: runtime.profile,
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    sessionName: sessionManager.getSessionName?.(),
    usage,
    projectMemory: runtime.projectMemory ?? [],
    memoryOverview: buildMemoryOverview(defaults.root),
    customCommands: listCustomCommands(runtime),
    thinking: runtime.session.thinkingLevel,
    model: model ? `${model.provider}/${model.id}` : "none",
  };
}

export function getActiveProfile(runtime) {
  return runtime.profile ?? detectDefaultProfile();
}

export function setProfile(runtime, profile) {
  const next = normalizeProfile(profile);
  if (!next) {
    throw new Error("Profile must be one of: elson, cara, auto.");
  }
  const resolved = next === "auto" ? detectDefaultProfile() : next;
  runtime.profile = resolved;
  injectActiveProfile(runtime.session, resolved);
  const sessionManager = runtime.session.sessionManager;
  if (typeof sessionManager.appendCustomEntry === "function" && sessionManager.getSessionFile?.()) {
    sessionManager.appendCustomEntry(CARA_PROFILE_CUSTOM_TYPE, {
      profile: resolved,
      source: next === "auto" ? "auto" : "manual",
      savedAt: new Date().toISOString(),
    });
  }
  return resolved;
}

export function buildCaraConsolidationPrompt(runtime) {
  return buildConsolidationPrompt({ ...runtime, root: defaults.root }, findProjectMemoryFiles(runtime.project));
}

export function listCustomCommands(runtime) {
  const dirs = getCustomCommandDirs(runtime);
  const commands = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const name = path.basename(entry.name, ".md").toLowerCase();
      const file = path.join(dir, entry.name);
      const text = readFileSync(file, "utf8");
      commands.push({
        name,
        file,
        description: extractCommandDescription(text) ?? "custom prompt",
      });
    }
  }
  return dedupeCommands(commands);
}

export function loadCustomCommand(runtime, commandName, args = "") {
  const name = String(commandName ?? "").replace(/^\//, "").trim().toLowerCase();
  const command = listCustomCommands(runtime).find((item) => item.name === name);
  if (!command) return undefined;
  const body = readFileSync(command.file, "utf8").trim();
  const argText = String(args ?? "").trim();
  if (body.includes("{{args}}")) return body.replaceAll("{{args}}", argText);
  return argText ? `${body}\n\nUser arguments:\n${argText}` : body;
}

export function saveCaraExitSummary(runtime, summary) {
  const sessionManager = runtime?.session?.sessionManager;
  if (!sessionManager?.getSessionFile?.()) return false;
  if (typeof sessionManager.appendCustomEntry !== "function") return false;
  sessionManager.appendCustomEntry(CARA_EXIT_CUSTOM_TYPE, {
    ...summary,
    savedAt: new Date().toISOString(),
  });
  return true;
}

export function calculateSessionUsage(sessionManager) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    assistantMessages: 0,
  };

  const entries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const messageUsage = entry.message.usage;
    if (!messageUsage) continue;
    usage.assistantMessages += 1;
    usage.input += numberValue(messageUsage.input);
    usage.output += numberValue(messageUsage.output);
    usage.cacheRead += numberValue(messageUsage.cacheRead);
    usage.cacheWrite += numberValue(messageUsage.cacheWrite);
    usage.reasoning += extractReasoningTokens(messageUsage);
    usage.cost += numberValue(messageUsage.cost?.total);
  }

  usage.total = usage.input + usage.output;
  return usage;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractReasoningTokens(usage) {
  return (
    numberValue(usage.reasoning) ||
    numberValue(usage.reasoningTokens) ||
    numberValue(usage.outputReasoning) ||
    numberValue(usage.outputReasoningTokens) ||
    numberValue(usage.outputDetails?.reasoning) ||
    numberValue(usage.outputDetails?.reasoningTokens) ||
    numberValue(usage.completionTokensDetails?.reasoningTokens) ||
    numberValue(usage.completion_tokens_details?.reasoning_tokens)
  );
}

export function setThinking(runtime, level) {
  const requested = String(level ?? "").trim().toLowerCase();
  if (!requested || requested === "next") {
    return runtime.session.cycleThinkingLevel() ?? runtime.session.thinkingLevel;
  }

  const levels = runtime.session.getAvailableThinkingLevels();
  if (!levels.includes(requested)) {
    throw new Error(`Thinking must be one of: ${levels.join(", ")}`);
  }
  runtime.session.setThinkingLevel(requested);
  return runtime.session.thinkingLevel;
}

export async function setModel(runtime, selector) {
  const query = String(selector ?? "").trim().toLowerCase();
  if (!query) {
    throw new Error("Choose a model from /models.");
  }

  const available = runtime.session.modelRegistry.getAvailable();
  const exact = available.find((model) => {
    const fullSlash = `${model.provider}/${model.id}`.toLowerCase();
    const fullColon = `${model.provider}:${model.id}`.toLowerCase();
    return fullSlash === query || fullColon === query || model.id.toLowerCase() === query;
  });
  const fuzzy = exact ?? available.find((model) => {
    const label = `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
    return label.includes(query);
  });

  if (!fuzzy) {
    throw new Error("Model not found or not authenticated. Use /models, or add it to pi models.json/auth first.");
  }

  await runtime.session.setModel(fuzzy);
  return fuzzy;
}

export function buildInspectPrompt() {
  return readPrompt(defaults.inspectPrompt);
}

export function checkSetup() {
  const sessions = getProjectSessionsDir(defaults.project);
  return {
    piRoot: existsSync(defaults.piRoot),
    tsx: existsSync(path.join(defaults.piRoot, "node_modules/tsx/dist/cli.mjs")),
    currentProject: existsSync(defaults.project),
    projectChatStorage: existsSync(sessions),
    guide: existsSync(defaults.prompt),
    inspectPrompt: existsSync(defaults.inspectPrompt),
  };
}

function injectProjectMemory(session, project) {
  const files = findProjectMemoryFiles(project);
  if (!files.length) return [];

  const sections = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8").trim();
    if (!text) continue;
    sections.push(`File: ${formatRelative(project, file)}\n${text.slice(0, 12000)}`);
  }
  if (!sections.length) return [];

  const addition = `\n\n<${CARA_PROJECT_MEMORY_MARKER}>\n${sections.join("\n\n---\n\n")}\n</${CARA_PROJECT_MEMORY_MARKER}>`;
  const currentBase = session._baseSystemPrompt ?? session.agent.state.systemPrompt ?? "";
  session._baseSystemPrompt = currentBase.includes(`<${CARA_PROJECT_MEMORY_MARKER}>`)
    ? currentBase.replace(new RegExp(`\\n\\n<${CARA_PROJECT_MEMORY_MARKER}>[\\s\\S]*?</${CARA_PROJECT_MEMORY_MARKER}>`), addition)
    : `${currentBase}${addition}`;
  session.agent.state.systemPrompt = session._baseSystemPrompt;
  return files.map((file) => formatRelative(project, file));
}

function injectLayeredMemory(session, root) {
  const memory = buildLayeredMemoryPrompt(root);
  if (!memory) return;
  const addition = `\n\n<${CARA_LAYERED_MEMORY_MARKER}>\n${memory}\n</${CARA_LAYERED_MEMORY_MARKER}>`;
  const currentBase = session._baseSystemPrompt ?? session.agent.state.systemPrompt ?? "";
  session._baseSystemPrompt = currentBase.includes(`<${CARA_LAYERED_MEMORY_MARKER}>`)
    ? currentBase.replace(new RegExp(`\\n\\n<${CARA_LAYERED_MEMORY_MARKER}>[\\s\\S]*?</${CARA_LAYERED_MEMORY_MARKER}>`), addition)
    : `${currentBase}${addition}`;
  session.agent.state.systemPrompt = session._baseSystemPrompt;
}

function injectActiveProfile(session, profile) {
  const label = profile === "elson" ? "Elson" : "Cara";
  const mode =
    profile === "elson"
      ? "The active operator is Elson. Treat requests as builder/testing/product work for Cara's CLI unless context clearly says Cara is using it. Keep the same warmth and natural voice; use this only to understand that the tool is being built, tested, debugged, or shaped."
      : "The active operator is Cara. Treat requests as a person using the tool to learn, code, ask, explore, or be accompanied. Keep the same warmth and natural voice; use this only to avoid assuming builder/admin intent.";
  const addition = `\n\n<${CARA_PROFILE_MARKER}>\nProfile: ${label}\n${mode}\n</${CARA_PROFILE_MARKER}>`;
  const currentBase = session._baseSystemPrompt ?? session.agent.state.systemPrompt ?? "";
  session._baseSystemPrompt = currentBase.includes(`<${CARA_PROFILE_MARKER}>`)
    ? currentBase.replace(new RegExp(`\\n\\n<${CARA_PROFILE_MARKER}>[\\s\\S]*?</${CARA_PROFILE_MARKER}>`), addition)
    : `${currentBase}${addition}`;
  session.agent.state.systemPrompt = session._baseSystemPrompt;
}

function findProjectMemoryFiles(project) {
  const files = [];
  let current = path.resolve(project);
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (existsSync(candidate)) files.unshift(candidate);
    if (current === root) break;
    current = path.dirname(current);
  }
  return files;
}

function getCustomCommandDirs(runtime) {
  return [
    path.join(defaults.root, "commands"),
    path.join(runtime.project, ".cara", "commands"),
  ];
}

function extractCommandDescription(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const frontmatterDescription = lines.find((line) => line.toLowerCase().startsWith("description:"));
  if (frontmatterDescription) return frontmatterDescription.slice("description:".length).trim();
  const heading = lines.find((line) => line.startsWith("#"));
  if (heading) return heading.replace(/^#+\s*/, "").trim();
  return lines[0]?.slice(0, 80);
}

function dedupeCommands(commands) {
  const byName = new Map();
  for (const command of commands) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatRelative(base, file) {
  const relative = path.relative(base, file);
  return relative && !relative.startsWith("..") ? relative : file;
}
