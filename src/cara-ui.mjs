import { stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { CaraComponentHost } from "./tui/component-host.mjs";
import { UserMessageComponent, AssistantMessageComponent, ToolMessageComponent } from "./tui/components/message-components.mjs";
import {
  accountPanel,
  codexUsagePanel,
  commandsPanel,
  errorPanel,
  infoPanel,
  LinesPanelComponent,
  memoryPanel,
  progressPanel,
  retryPanel,
  sessionInfoPanel,
  statusPanel,
} from "./tui/components/static-panels.mjs";
import { runTerminalInputLoop } from "./terminal-input.mjs";
import { applyTerminalTheme, buildTerminalTheme } from "./terminal-theme.mjs";

const bold = "\x1b[1m";
const reset = "\x1b[0m";
const fallbackTheme = buildTerminalTheme();
const startupSpinnerMs = 80;
const outroMessages = loadJson("./outro-messages.json", {
  sessionComplete: ["another great coding session complete... or not, who knows"],
  fromElson: ["I am always rooting for her."],
});

export function createCaraUi(options = {}) {
  const theme = buildTerminalTheme(options.terminalTheme ?? options.theme);
  const host = new CaraComponentHost({ output });
  const assistantLifecycle = new AssistantMessageLifecycle();
  const activeTools = new Map();
  let activeAssistantComponent = null;
  let activeAssistantKey = "";
  let activeProgress = null;
  let pendingAssistantCommit = null;
  let isBusy = false;
  let suppressWorking = false;
  let activityLabel = "";
  let inputActive = false;
  const committedAssistantIds = new Set();
  const committedAssistantKeys = new Set();

  const appendPanel = (component) => {
    if (inputActive) host.append(component);
    else host.printLines(component.render(host.width()));
  };

  const appendLines = (lines) => {
    appendPanel(new LinesPanelComponent(`lines-${Date.now()}-${Math.random()}`, lines));
  };

  const setAssistantComponentContent = (content, options = {}) => {
    if (!hasAssistantContent(content)) return;
    if (!activeAssistantComponent) {
      activeAssistantKey = `assistant-${assistantMessageIdentity(options.message) || Date.now()}`;
      activeAssistantComponent = new AssistantMessageComponent(activeAssistantKey, content, theme);
      if (inputActive) host.append(activeAssistantComponent);
    }
    activeAssistantComponent.setContent(content, options);
  };

  const commitAssistant = (message, content) => {
    if (!hasAssistantContent(content)) return;
    const id = assistantMessageIdentity(message);
    const key = assistantContentKey(content);

    if (inputActive) {
      if (id && committedAssistantIds.has(id) && committedAssistantKeys.has(key)) return;
      if (id) committedAssistantIds.add(id);
      committedAssistantKeys.add(key);
      setAssistantComponentContent(content, { final: true, message });
    } else {
      pendingAssistantCommit = { id, key, content };
    }
  };

  const flushAssistantCommit = () => {
    const pending = pendingAssistantCommit;
    pendingAssistantCommit = null;
    if (!pending?.content || !pending.key) return;
    if ((pending.id && committedAssistantIds.has(pending.id)) || committedAssistantKeys.has(pending.key)) return;
    if (pending.id) committedAssistantIds.add(pending.id);
    committedAssistantKeys.add(pending.key);
    const component = new AssistantMessageComponent(`assistant-committed-${pending.id || Date.now()}`, pending.content, theme);
    host.printLines(component.render(host.width()));
  };

  const beginAssistant = (message) => {
    suppressWorking = false;
    activityLabel = "thinking";
    assistantLifecycle.start(message);
    activeAssistantComponent = null;
    activeAssistantKey = "";
    host.invalidate();
  };

  const streamAssistantEvent = (event) => {
    const content = assistantLifecycle.update(event);
    activityLabel = activityFromAssistantEvent(event);
    if (inputActive) {
      setAssistantComponentContent(content, { message: event.message });
    }
    if (activeProgress) {
      updateProgressBox({
        done: false,
        label: "writing",
        detail: "turning the scan into the start note",
        percent: Math.max(activeProgress.percent, 88),
      });
    } else {
      host.invalidate();
    }
  };

  const finishAssistant = (message) => {
    activityLabel = "writing";
    suppressWorking = true;
    const finalContent = assistantLifecycle.end(message);
    if (!finalContent) {
      host.invalidate();
      return;
    }
    if (activeProgress) activeProgress.done = true;
    commitAssistant(message, finalContent);
  };

  const updateTool = (event, state) => {
    const toolCallId = event.toolCallId ?? event.id ?? `${event.toolName ?? event.name ?? "tool"}:${activeTools.size}`;
    const current = activeTools.get(toolCallId) ?? {};
    const next = {
      ...current,
      ...event,
      state,
      toolCallId,
      toolName: event.toolName ?? event.name ?? current.toolName ?? "tool",
      args: event.args ?? event.arguments ?? current.args,
      result: event.result ?? event.partialResult ?? current.result,
      isError: event.isError ?? state === "error",
    };

    if (activeProgress) {
      updateProgressBox(progressPatchFromTool(activeProgress, next, state));
      return;
    }

    const key = `tool-${toolCallId}`;
    let component = activeTools.get(toolCallId)?.component;
    if (!component) {
      component = new ToolMessageComponent(key, next, theme);
      if (inputActive) host.append(component);
    }
    component.update(next);

    if (state === "running") {
      activeTools.set(toolCallId, { ...next, component });
      suppressWorking = false;
      activityLabel = activityFromTool(next);
      if (!inputActive) {
        // Non-interactive turns keep running tool rows out of stdout until they finish.
        return;
      }
      host.invalidate();
      return;
    }

    activeTools.delete(toolCallId);
    activityLabel = activeTools.size > 0 ? activityFromTool(activeTools.values().next().value) : "thinking";
    if (!inputActive) host.printLines(component.render(host.width()));
    else host.invalidate();
  };

  const beginProgressBox = (title = "Working") => {
    activeProgress = {
      title,
      label: "starting",
      detail: "setting up the repo scan",
      percent: 4,
      toolCount: 0,
      toolIds: new Set(),
      done: false,
    };
    activityLabel = title.toLowerCase();
    suppressWorking = false;
    renderProgressComponent();
  };

  const updateProgressBox = (next = {}) => {
    if (!activeProgress) return;
    activeProgress = {
      ...activeProgress,
      ...next,
      percent: clamp(Number(next.percent ?? activeProgress.percent) || 0, 0, 100),
    };
    renderProgressComponent();
  };

  const finishProgressBox = () => {
    if (!activeProgress) return;
    activeProgress = null;
    host.remove("progress");
    host.invalidate();
  };

  const renderProgressComponent = () => {
    if (!activeProgress) return;
    if (inputActive) {
      const existing = host.components.find((component) => component.key === "progress");
      const lines = progressPanel(activeProgress, theme, host.width()).render(host.width());
      if (existing?.setLines) existing.setLines(lines);
      else host.append(new LinesPanelComponent("progress", lines));
    }
  };

  return {
    banner(status = {}) {
      const project = status.project ?? options.project ?? process.cwd();
      const model = status.model ?? options.model ?? "loading";
      const thinking = status.thinking ?? options.thinking ?? "medium";
      const themeName = status.terminalTheme ?? theme.name ?? "theme";
      appendLines([
        `${theme.accent}✦${reset} ${bold}${theme.primary}Cara${reset}`,
        `   ${theme.muted}${formatHomePath(project)}${reset}`,
        `   ${theme.info}${model}${reset} ${theme.muted}·${reset} ${theme.warning}${thinking}${reset} ${theme.muted}·${reset} ${theme.accent}${themeName}${reset}`,
        "",
        `   ${theme.primary}/start${reset} ${theme.muted}to orient ·${reset} ${theme.accent}/themes${reset} ${theme.muted}to change the room ·${reset} ${theme.success}@file${reset} ${theme.muted}to bring context${reset}`,
        "",
      ]);
    },
    commands() {
      appendPanel(commandsPanel(theme, host.width()));
    },
    status(status) {
      appendPanel(statusPanel(status, theme, host.width()));
    },
    account(account) {
      appendPanel(accountPanel(account, theme, host.width()));
    },
    codexUsage(stats) {
      appendPanel(codexUsagePanel(stats, theme, host.width()));
    },
    starting(label = "Starting agent") {
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let frame = 0;
      let stopped = false;
      const width = () => Math.max(24, (output.columns ?? 100) - 1);
      const render = () => {
        if (stopped) return;
        const text = `${theme.accent}${frames[frame % frames.length]}${reset} ${theme.muted}${label}${reset}`;
        frame += 1;
        output.write(`\r${padDisplay(text, width())}`);
      };
      output.write("\n");
      render();
      const timer = setInterval(render, startupSpinnerMs);
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        output.write(`\r${" ".repeat(width())}\r`);
      };
    },
    beginProgress(title) {
      beginProgressBox(title);
    },
    endProgress() {
      finishProgressBox();
    },
    memory(status) {
      appendPanel(memoryPanel(status, theme));
    },
    sessionInfo(info = {}) {
      appendPanel(sessionInfoPanel(info, theme));
    },
    event(event) {
      if (event.type === "turn_start") {
        isBusy = true;
        suppressWorking = false;
        activityLabel = "thinking";
        host.invalidate();
      }
      if (event.type === "message_start" && event.message?.role === "assistant") beginAssistant(event.message);
      if (event.type === "message_update" && event.message?.role === "assistant") {
        streamAssistantEvent(event);
        return;
      }
      if (event.type === "tool_execution_start") updateTool(event, "running");
      if (event.type === "tool_execution_update") updateTool(event, "running");
      if (event.type === "tool_execution_end") updateTool(event, event.isError ? "error" : "done");
      if (event.type === "message_end" && event.message?.role === "assistant") finishAssistant(event.message);
      if (event.type === "turn_end" || event.type === "agent_end") {
        flushAssistantCommit();
        isBusy = false;
        suppressWorking = false;
        activityLabel = "";
        activeAssistantComponent = null;
        activeAssistantKey = "";
        host.invalidate();
      }
      if (event.type === "auto_retry_start") {
        activityLabel = "retrying";
        appendPanel(retryPanel(event, theme, host.width()));
      }
      if (event.type === "compaction_start") {
        activityLabel = "compacting";
        appendLines([`${theme.warning}compact${reset} ${event.reason}`]);
      }
    },
    error(error) {
      appendPanel(errorPanel(error, theme));
    },
    info(text) {
      appendPanel(infoPanel(text, theme));
    },
    block(lines = []) {
      appendLines(Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/));
    },
    setTheme(nextTheme) {
      applyTerminalTheme(theme, nextTheme);
      host.inputComponent?.setTheme?.(theme);
      host.invalidate({ force: true });
    },
    themes(themes, activeName) {
      const lines = ["", `${bold}Themes${reset}`];
      for (const item of themes) {
        const active = item.name === activeName ? `${theme.success}*${reset}` : " ";
        const source = item.source ? ` ${theme.muted}${item.source}${reset}` : "";
        lines.push(` ${active} ${theme.primary}${item.name}${reset} ${theme.muted}${item.displayName ?? item.description ?? ""}${reset}${source}`);
      }
      appendLines(lines);
    },
    async interactive(onInput, options = {}) {
      inputActive = true;
      await runTerminalInputLoop(onInput, { ...options, theme }, {
        host,
        getBusy: () => isBusy,
        getActivityLabel: () => activityLabel,
        suppressWorking: () => suppressWorking,
        onUserMessage(text) {
          host.append(new UserMessageComponent(`user-${Date.now()}`, text, theme));
        },
        onError(error) {
          appendPanel(errorPanel(error, theme));
        },
        setRenderers() {},
        clearRenderers() {
          inputActive = false;
        },
      });
    },
    done() {
      appendLines(["", `${theme.muted}done${reset}`]);
    },
    goodbye(status) {
      const sessionComplete = pick(outroMessages.sessionComplete);
      const fromElson = pick(outroMessages.fromElson);
      appendLines(["", `${theme.primary}${sessionComplete}${reset}`, `${theme.muted}btw elson says:${reset} ${fromElson}`]);
      return {
        sessionComplete,
        fromElson,
        technicalLines: [],
        usage: status.usage,
        sessionId: status.sessionId,
        sessionFile: status.sessionFile,
      };
    },
    _host: host,
    _debugBeginInteractiveForTests() {
      inputActive = true;
    },
    _debugRenderLinesForTests(width = host.width()) {
      return host.renderLines(width);
    },
  };
}

function summarizeTool(event) {
  const args = event.args ?? event.arguments;
  if (!args || typeof args !== "object") return "";
  const path = args.path ?? args.filePath ?? args.cwd ?? args.command ?? args.cmd;
  if (typeof path === "string" && path.length > 0) return truncate(path, 80);
  const keys = Object.keys(args).filter((key) => args[key] !== undefined && args[key] !== null);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).join(", ");
}

function activityFromAssistantEvent(event) {
  const update = event.assistantMessageEvent;
  if (update?.type === "thinking_start" || update?.type === "thinking_delta") return "thinking";
  if (update?.type === "text_start" || update?.type === "text_delta" || hasAssistantContent(extractAssistantContent(event.message?.content))) return "writing";
  if (update?.type === "toolcall_start" || update?.type === "toolcall_delta") return activityFromTool(update);
  return "thinking";
}

function formatToolActivity(value) {
  return String(value ?? "tool").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase() || "tool";
}

function activityFromTool(toolState = {}) {
  const rawName = toolState.toolName ?? toolState.name ?? toolState.functionName ?? toolState.type ?? "tool";
  const name = formatToolActivity(rawName);
  const args = toolState.args ?? toolState.arguments ?? {};
  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  const value = `${name} ${command}`.toLowerCase();
  if (/\b(web|browser|chrome|navigate|click|screenshot)\b/.test(value)) return "browsing";
  if (/\b(search|find|grep|rg|list|ls|read|get|open|cat|sed|head|tail|view)\b/.test(value)) return "reading files";
  if (/\b(apply patch|patch|edit|write|create|update|replace|move|copy|delete|remove|mkdir)\b/.test(value)) return "editing";
  if (/\b(test|check|typecheck|lint|build|verify|doctor)\b/.test(value)) return "checking";
  if (/\b(exec|command|shell|bash|powershell|cmd|npm|node|bun|pnpm|yarn|git|run)\b/.test(value)) return "running command";
  return name && name !== "tool" ? `using ${name}` : "working";
}

function progressPatchFromTool(progress, toolState, state) {
  if (!toolState || !progress) return {};
  const toolId = toolState.toolCallId ?? toolState.id ?? toolState.toolName ?? "tool";
  const seen = progress.toolIds ?? new Set();
  const firstSeen = !seen.has(toolId);
  seen.add(toolId);
  const toolCount = progress.toolCount + (firstSeen ? 1 : 0);
  const running = state === "running";
  const toolName = formatToolActivity(toolState.toolName);
  const summary = summarizeTool(toolState);
  const percent = running
    ? Math.min(82, Math.max(progress.percent + 3, 12 + toolCount * 12))
    : Math.min(86, Math.max(progress.percent + 5, 20 + toolCount * 13));
  return {
    toolIds: seen,
    toolCount,
    done: false,
    label: running ? `checking ${toolName}` : `checked ${toolName}`,
    detail: summary || "reading project files",
    percent,
  };
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatHomePath(value) {
  const text = String(value ?? "");
  const home = os.homedir();
  if (!home) return text;
  if (text.toLowerCase() === home.toLowerCase()) return "~";
  if (text.toLowerCase().startsWith(`${home.toLowerCase()}\\`) || text.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return `~${text.slice(home.length)}`;
  return text;
}

function padDisplay(text, width) {
  const value = String(text);
  return `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)] ?? "";
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  } catch {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function emptyAssistantContent() {
  return { thinking: "", text: "", hasThinkingBlock: false };
}

function hasAssistantContent(content) {
  return Boolean(content?.text?.trim());
}

function normalizeAssistantContent(primary, fallback) {
  if (hasAssistantContent(primary)) return primary;
  return fallback;
}

function extractAssistantEventContent(event, current = emptyAssistantContent()) {
  const messageContent = extractAssistantContent(event.message?.content);
  const partialContent = extractAssistantContent(event.assistantMessageEvent?.partial?.content);
  const next = longerAssistantContent(messageContent, partialContent, current);
  if (hasAssistantContent(next) && assistantContentKey(next) !== assistantContentKey(current)) return next;
  const delta = event.assistantMessageEvent;
  if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.length > 0) {
    return { ...current, text: mergeAssistantTextDelta(current.text, delta.delta) };
  }
  return next;
}

export class AssistantMessageLifecycle {
  constructor() {
    this.open = false;
    this.content = emptyAssistantContent();
    this.lastCommittedKey = "";
  }

  start(message = {}) {
    this.open = true;
    this.content = extractAssistantContent(message.content);
    return this.content;
  }

  update(event = {}) {
    if (!this.open) this.start(event.message ?? {});
    const next = extractAssistantEventContent(event, this.content);
    if (hasAssistantContent(next)) this.content = next;
    return this.content;
  }

  end(message = {}) {
    const finalContent = normalizeAssistantContent(extractAssistantContent(message.content), this.content);
    const finalKey = assistantContentKey(finalContent);
    this.open = false;
    this.content = emptyAssistantContent();
    if (!finalKey || finalKey === this.lastCommittedKey) return null;
    this.lastCommittedKey = finalKey;
    return finalContent;
  }

  hasTransient() {
    return Boolean(this.open && hasAssistantContent(this.content));
  }

  getTransient() {
    return this.content;
  }
}

export function mergeAssistantTextDelta(currentText, deltaText) {
  if (!currentText) return deltaText;
  if (!deltaText) return currentText;
  if (deltaText === currentText || currentText.endsWith(deltaText)) return currentText;
  if (deltaText.startsWith(currentText)) return deltaText;
  return `${currentText}${deltaText}`;
}

function longerAssistantContent(...contents) {
  return contents.reduce((best, content) => {
    if (!hasAssistantContent(content)) return best;
    return content.text.length > best.text.length ? content : best;
  }, emptyAssistantContent());
}

function assistantContentKey(content) {
  return content?.text?.trim() ?? "";
}

function assistantMessageIdentity(message = {}) {
  const value = message.id ?? message.messageId ?? message.entryId ?? message.uuid;
  return value ? String(value) : "";
}

export function extractAssistantContent(content) {
  if (typeof content === "string") return { thinking: "", text: content };
  if (!Array.isArray(content)) return emptyAssistantContent();
  const thinking = [];
  const text = [];
  let hasThinkingBlock = false;
  for (const part of content) {
    if (part?.type === "thinking") {
      hasThinkingBlock = true;
      const value = part.thinking ?? part.text ?? "";
      if (value) thinking.push(value);
    } else if (part?.type === "text") {
      const value = part.text ?? "";
      if (value) text.push(value);
    }
  }
  return { thinking: thinking.join("\n"), text: text.join("\n"), hasThinkingBlock };
}

export function extractText(content) {
  return extractAssistantContent(content).text;
}
