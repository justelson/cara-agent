import {
  buildZyraAuthAccountStatus,
  buildSessionInfo,
  createZyraMemoryController,
  describeRuntime,
  fetchCodexUsageStats,
  loadCustomCommand,
  loginZyraAuth,
  logoutZyraAuth,
  reloadZyraRuntime,
  runZyraPrompt,
  setModel,
  setNotifications,
  setProfile,
  setStatusLine,
  setThinking,
  setWebFetch,
  setWebSearch,
  setWebTools,
  setZyraTheme,
} from "./zyra-sdk.mjs";
import { buildProjectStartPrompt } from "./project-start.mjs";
import { getSlashCommand, parseSlashInput } from "./slash-commands.mjs";
import { normalizeWebToolsMode } from "./web-tools-picker.mjs";

export async function handleSlash(runtime, ui, input, controls = {}) {
  const text = String(input ?? "").trim();
  if (!text.startsWith("/") && !["exit", "quit"].includes(text.toLowerCase())) return false;

  const parsed = parseSlashInput(text.startsWith("/") ? text : `/${text}`);
  const command = parsed.command;
  const name = command?.name ?? parsed.commandName;
  const arg = parsed.arg;

  if (name === "exit") return true;

  if (!command) {
    return runCustomSlashCommand(runtime, ui, `/${parsed.commandName}`, arg, controls);
  }

  switch (name) {
    case "commands":
      ui.commands();
      return true;
    case "start":
      return runStart(runtime, ui, arg, controls);
    case "session":
      ui.status(describeRuntime(runtime));
      return true;
    case "profile":
      return runProfile(runtime, ui, arg);
    case "memory":
      return runMemory(runtime, ui, arg);
    case "web":
      return runWeb(runtime, ui, arg);
    case "websearch":
      return runWebSearch(runtime, ui, arg);
    case "webfetch":
      return runWebFetch(runtime, ui, arg);
    case "auth":
      return runAuth(ui, arg);
    case "codexusage":
      return runCodexUsage(ui);
    case "login":
      return runLogin(ui, arg, controls);
    case "logout":
      return runLogout(ui, arg);
    case "reload":
      return runReload(runtime, ui, arg, controls);
    case "new":
      await controls.startFreshChat?.();
      return true;
    case "compact":
      return runCompact(runtime, ui, controls);
    case "chat":
      ui.sessionInfo(buildSessionInfo(runtime));
      return true;
    case "thinking":
      return runThinking(runtime, ui, arg);
    case "themes":
      return runThemes(runtime, ui, arg);
    case "models":
      return runModels(runtime, ui, arg);
    case "statusline":
      return runStatusLine(runtime, ui, arg);
    case "notifications":
      return runNotifications(runtime, ui, arg);
    default:
      return runCustomSlashCommand(runtime, ui, `/${parsed.commandName}`, arg, controls);
  }
}

async function runStart(runtime, ui, arg, controls) {
  ui.beginProgress("Project scan");
  controls.setTerminalTitleState?.("working");
  try {
    await runZyraPrompt(runtime, buildProjectStartPrompt(runtime, arg));
    controls.notifyTerminalIfUnfocused?.();
  } finally {
    ui.endProgress();
    controls.setTerminalTitleState?.("ready");
  }
  return true;
}

function runProfile(runtime, ui, arg) {
  if (!arg) {
    ui.info(`Profile: ${describeRuntime(runtime).profile}`);
    return true;
  }
  const profile = setProfile(runtime, arg);
  ui.info(`Profile: ${profile}`);
  return true;
}

function runMemory(runtime, ui, arg) {
  const memory = createZyraMemoryController(runtime);
  const action = arg.trim().toLowerCase();
  if (action && !["on", "off", "enable", "enabled", "disable", "disabled"].includes(action)) {
    ui.info("Usage: /memory, /memory on, /memory off");
    return true;
  }

  const current = memory.threadMode();
  const nextMode = ["on", "enable", "enabled"].includes(action)
    ? "enabled"
    : ["off", "disable", "disabled"].includes(action)
      ? "disabled"
      : current.mode === "enabled" ? "disabled" : "enabled";
  const result = memory.setThreadMode(nextMode);
  ui.info(`Memory ${result.mode === "enabled" ? "on" : "off"} for this chat.`);
  return true;
}

async function runWeb(runtime, ui, arg) {
  const mode = normalizeWebToolsMode(arg);
  const selected = mode ?? await ui.selectWebTools?.({
    webSearch: runtime.webSearch,
    webFetch: runtime.webFetch,
  });
  if (!selected) {
    ui.info("Web tools unchanged.");
    return true;
  }
  const next = setWebTools(runtime, selected);
  ui.info(formatWebToolsStatus(next));
  return true;
}

function runWebSearch(runtime, ui, arg) {
  const action = arg.trim().toLowerCase();
  if (action && !["on", "off", "enable", "enabled", "disable", "disabled"].includes(action)) {
    ui.info("Usage: /websearch, /websearch on, /websearch off");
    return true;
  }
  const enabled = setWebSearch(runtime, action || undefined);
  ui.info(`Web search ${enabled ? "on" : "off"}.`);
  return true;
}

function runWebFetch(runtime, ui, arg) {
  const action = arg.trim().toLowerCase();
  if (action && !["on", "off", "enable", "enabled", "disable", "disabled"].includes(action)) {
    ui.info("Usage: /webfetch, /webfetch on, /webfetch off");
    return true;
  }
  const enabled = setWebFetch(runtime, action || undefined);
  ui.info(`Web fetch ${enabled ? "on" : "off"}.`);
  return true;
}

async function runAuth(ui, arg) {
  ui.info("Checking auth...");
  ui.account(await buildZyraAuthAccountStatus(arg || "openai-codex"));
  return true;
}

async function runCodexUsage(ui) {
  ui.info("Checking Codex usage...");
  ui.codexUsage(await fetchCodexUsageStats());
  return true;
}

async function runLogin(ui, arg, controls) {
  const provider = arg || "openai-codex";
  ui.beginProgress("ChatGPT login");
  controls.setTerminalTitleState?.("working");
  try {
    await loginZyraAuth(provider, { onMessage: (message) => ui.info(message) });
    ui.account(await buildZyraAuthAccountStatus(provider));
  } finally {
    ui.endProgress();
    controls.setTerminalTitleState?.("ready");
  }
  return true;
}

async function runLogout(ui, arg) {
  const provider = arg || "openai-codex";
  ui.info(`Logging out of ${provider}...`);
  await logoutZyraAuth(provider);
  ui.account(await buildZyraAuthAccountStatus(provider));
  return true;
}

async function runReload(runtime, ui, arg, controls) {
  if (arg.trim() === "--soft") {
    ui.info("Reloading commands, themes, prompt, and memory without restarting...");
    controls.setTerminalTitleState?.("reloading");
    const result = await reloadZyraRuntime(runtime);
    ui.setTheme(result.theme);
    ui.info(`Reloaded resources: ${result.commands} command${result.commands === 1 ? "" : "s"}, ${result.themes} theme${result.themes === 1 ? "" : "s"}.`);
    controls.setTerminalTitleState?.("ready");
    return true;
  }
  controls.setTerminalTitleState?.("reloading");
  ui.restartTransition("reloading zyra");
  return "restart";
}

async function runCompact(runtime, ui, controls) {
  const memory = createZyraMemoryController(runtime);
  ui.beginProgress("Compacting memory");
  controls.setTerminalTitleState?.("compacting");
  try {
    const result = await memory.consolidate();
    ui.info(memory.formatConsolidationResult(result));
  } finally {
    ui.endProgress();
    controls.setTerminalTitleState?.("ready");
  }
  return true;
}

function runThinking(runtime, ui, arg) {
  const level = setThinking(runtime, arg);
  ui.info(`Thinking: ${level}`);
  return true;
}

function runThemes(runtime, ui, arg) {
  if (!arg) {
    ui.themes(describeRuntime(runtime).themes, runtime.terminalTheme?.name);
    return true;
  }
  const theme = setZyraTheme(runtime, arg);
  ui.setTheme(theme);
  ui.info(`Theme: ${theme.name}`);
  return true;
}

async function runModels(runtime, ui, arg) {
  if (!arg) {
    ui.info("Choose a model from the picker: type /models and press Enter.");
    return true;
  }
  const model = await setModel(runtime, arg);
  ui.info(`Model: ${model.provider}/${model.id}`);
  return true;
}

function runStatusLine(runtime, ui, arg) {
  if (!arg) {
    ui.info(`Status line: ${runtime.statusLine ?? "default"}. Use /statusline default|minimal|full|off.`);
    return true;
  }
  const next = setStatusLine(runtime, arg);
  ui.info(`Status line: ${next}.`);
  return true;
}

function runNotifications(runtime, ui, arg) {
  if (!arg) {
    ui.info(`Notifications: ${runtime.notifications ?? "unfocused"}. Use /notifications unfocused|always|off.`);
    return true;
  }
  const next = setNotifications(runtime, arg);
  ui.info(`Notifications: ${formatNotificationMode(next)}.`);
  return true;
}

async function runCustomSlashCommand(runtime, ui, rawCommand, arg, controls) {
  const customPrompt = loadCustomCommand(runtime, rawCommand, arg);
  if (customPrompt) {
    controls.setTerminalTitleState?.("thinking");
    try {
      await runZyraPrompt(runtime, customPrompt);
      controls.notifyTerminalIfUnfocused?.();
    } finally {
      controls.setTerminalTitleState?.("ready");
    }
    return true;
  }

  if (!getSlashCommand(rawCommand)) {
    ui.error(new Error("Unknown slash command. Type /commands."));
  }
  return true;
}

function formatWebToolsStatus(status = {}) {
  if (status.webSearch && status.webFetch) return "Web tools: all on.";
  if (!status.webSearch && !status.webFetch) return "Web tools: off.";
  if (status.webSearch) return "Web tools: search only.";
  return "Web tools: fetch only.";
}

function formatNotificationMode(mode) {
  if (mode === "always") return "always ring when a turn finishes";
  if (mode === "off") return "off";
  return "ring only when the terminal is not focused";
}
