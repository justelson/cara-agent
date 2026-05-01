import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeOpeningTheme, pickOpeningTheme } from "./banner.mjs";

const PI_ROOT = path.resolve("C:/Users/elson/my_coding_play/play projects/pi");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARA_THEME_CUSTOM_TYPE = "cara.theme.v1";
const CARA_EXIT_CUSTOM_TYPE = "cara.exit.v1";

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
  const result = await createAgentSession({
    cwd: sessionManager.getCwd?.() ?? project,
    sessionManager,
    thinkingLevel: thinking,
    sessionStartEvent: { type: "session_start", reason: options.sessionMode === "continue" || options.session ? "resume" : "new" },
  });

  injectCaraGuide(result.session, readPrompt(defaults.prompt));

  await preferDefaultModel(result.session, options.model ?? defaults.model);

  return {
    session: result.session,
    project,
    sessions,
    theme,
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
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    sessionName: sessionManager.getSessionName?.(),
    usage,
    thinking: runtime.session.thinkingLevel,
    model: model ? `${model.provider}/${model.id}` : "none",
  };
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
