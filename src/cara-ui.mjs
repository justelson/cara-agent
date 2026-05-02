import { stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import { renderOpeningBanner } from "./banner.mjs";
import { renderMarkdown } from "./pi-markdown.mjs";
import { runTerminalInputLoop } from "./terminal-input.mjs";
import { buildTerminalTheme } from "./terminal-theme.mjs";

const bold = "\x1b[1m";
const italic = "\x1b[3m";
const reset = "\x1b[0m";
const fallbackTheme = buildTerminalTheme();
const muted = fallbackTheme.muted;
const green = fallbackTheme.success;
const yellow = fallbackTheme.warning;
const red = fallbackTheme.error;
const assistantPadding = "  ";
const outroMessages = loadJson("./outro-messages.json", {
  sessionComplete: ["another great coding session complete... or not, who knows"],
  fromElson: ["I am always rooting for her."],
});

export function createCaraUi(options = {}) {
  const theme = buildTerminalTheme(options.theme);
  let lastAssistantText = "";
  let streamingAssistantContent = emptyAssistantContent();
  let assistantOpen = false;
  const activeTools = new Map();
  let isBusy = false;
  let inputActive = false;
  let renderInput = () => {};
  let clearInput = () => {};
  let renderTimer = undefined;
  let suppressWorking = false;
  let activityLabel = "";

  function write(text = "") {
    output.write(text);
  }

  function line(text = "") {
    print(`${text}\n`);
  }

  function print(text = "") {
    if (inputActive) clearInput();
    write(text);
    if (inputActive) renderInput();
  }

  function requestInputRender() {
    if (!inputActive) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderInput();
    }, 90);
  }

  function flushInputRender() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    if (inputActive) renderInput();
  }

  function cancelInputRender() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
  }

  function title(text) {
    line(`${theme.primary}${text}${reset}`);
  }

  function note(label, text) {
    line(`${theme.muted}${label}:${reset} ${text}`);
  }

  function headerNote(label, text, color) {
    line(`${bold}${color}${label}${reset}${theme.muted}:${reset} ${text}`);
  }

  function beginAssistant() {
    if (assistantOpen) return;
    suppressWorking = false;
    activityLabel = "thinking";
    assistantOpen = true;
    streamingAssistantContent = emptyAssistantContent();
  }

  function streamAssistant(content) {
    const next = normalizeAssistantContent(extractAssistantContent(content), streamingAssistantContent);
    if (!hasAssistantContent(next)) return;
    beginAssistant();
    activityLabel = "writing";
    streamingAssistantContent = next;
    requestInputRender();
  }

  function streamAssistantEvent(event) {
    const next = extractAssistantEventContent(event, streamingAssistantContent);
    if (!hasAssistantContent(next)) return;
    beginAssistant();
    activityLabel = activityFromAssistantEvent(event);
    streamingAssistantContent = next;
    requestInputRender();
  }

  function finishAssistant(content) {
    cancelInputRender();
    const finalContent = normalizeAssistantContent(extractAssistantContent(content), streamingAssistantContent);
    const finalKey = assistantContentKey(finalContent);
    streamingAssistantContent = emptyAssistantContent();
    assistantOpen = false;
    activityLabel = "writing";
    suppressWorking = true;
    if (!finalKey || finalKey === lastAssistantText) {
      renderInput();
      return;
    }
    print(`${formatAssistantContent(finalContent, theme).join("\n")}\n`);
    lastAssistantText = finalKey;
  }

  function tool(event, state) {
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

    if (state === "running") {
      suppressWorking = false;
      activityLabel = `using ${formatToolActivity(next.toolName)}`;
      activeTools.set(toolCallId, next);
      requestInputRender();
      return;
    }

    cancelInputRender();
    activeTools.delete(toolCallId);
    activityLabel = activeTools.size > 0 ? `using ${formatToolActivity(activeTools.values().next().value?.toolName)}` : "thinking";
    print(renderToolBlock(next, theme).join("\n"));
  }

  return {
    banner() {
      for (const bannerLine of renderOpeningBanner(undefined, options.theme)) {
        line(bannerLine);
      }
      line("");
    },
    commands() {
      line(`${bold}Slash commands${reset}
  /commands             show this list
  /status               show project, model, and thinking
  /profile              show active profile
  /profile <name>       auto, elson, cara
  /thinking             cycle thinking effort
  /thinking <level>     off, minimal, low, medium, high, xhigh
  /models               open model picker
  /models <provider/model>
  /sessions             show local chats
  /memory               summarize what Cara memory knows
  /consolidate          clean and update Cara memory layers
  /reload               reload custom slash commands
  /<custom>             run .cara/commands/<custom>.md
  /exit                 leave`);
    },
    status(status) {
      note("project", status.project);
      note("profile", status.profile);
      note("model", status.model);
      note("thinking", status.thinking);
      note("sessions", status.sessions);
      note("chat", status.sessionId);
      if (status.sessionName) note("name", status.sessionName);
      if (status.sessionFile) note("file", status.sessionFile);
      if (status.projectMemory?.length) note("memory", status.projectMemory.join(", "));
      if (status.customCommands?.length) note("commands", status.customCommands.map((command) => `/${command.name}`).join(", "));
    },
    memory(status) {
      const overview = status.memoryOverview ?? ["What I know about Cara", "  Nothing stable yet."];
      const commands = status.customCommands ?? [];
      for (const memoryLine of overview) {
        if (!memoryLine) {
          line("");
        } else if (!memoryLine.startsWith("  ") && !memoryLine.startsWith("- ")) {
          line(`${bold}${theme.primary}${memoryLine}${reset}`);
        } else {
          line(`${theme.muted}${memoryLine}${reset}`);
        }
      }
      line("");
      line(`${bold}Custom commands${reset}`);
      if (!commands.length) {
        line(`${theme.muted}  Add markdown commands in .cara/commands/*.md.${reset}`);
      } else {
        for (const command of commands) {
          line(`  ${theme.success}/${command.name}${reset} ${theme.muted}${command.description}${reset}`);
        }
      }
    },
    sessions(sessions) {
      if (!sessions.length) {
        line(`${theme.muted}No local chats yet.${reset}`);
        return;
      }
      line(`${bold}Local chats${reset}`);
      for (const session of sessions.slice(0, 20)) {
        const id = session.id.slice(0, 8);
        const title = session.name || session.firstMessage || "(no messages)";
        const when = formatSessionTime(session.modified);
        const count = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;
        line(`  ${theme.success}${id}${reset}  ${truncate(title.replace(/\s+/g, " "), 58)}`);
        line(`      ${theme.muted}${when} - ${count} - ${formatSessionPath(session.path)}${reset}`);
      }
      if (sessions.length > 20) {
        line(`${theme.muted}${sessions.length - 20} more chats hidden. Resume with a longer id if needed.${reset}`);
      }
    },
    event(event) {
      if (event.type === "turn_start") {
        isBusy = true;
        suppressWorking = false;
        activityLabel = "thinking";
        flushInputRender();
      }
      if (event.type === "turn_end") {
        isBusy = false;
        suppressWorking = false;
        activityLabel = "";
        flushInputRender();
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        beginAssistant();
      }
      if (event.type === "message_update" && event.message?.role === "assistant") {
        streamAssistantEvent(event);
        return;
      }
      if (event.type === "tool_execution_start") tool(event, "running");
      if (event.type === "tool_execution_update") tool(event, "running");
      if (event.type === "tool_execution_end") tool(event, event.isError ? "error" : "done");
      if (event.type === "message_end" && event.message?.role === "assistant") {
        finishAssistant(event.message.content);
      }
      if (event.type === "auto_retry_start") {
        activityLabel = "retrying";
        line(`${theme.warning}retry${reset} ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
      }
      if (event.type === "compaction_start") {
        activityLabel = "compacting";
        line(`${theme.warning}compact${reset} ${event.reason}`);
      }
    },
    error(error) {
      print(["", `${theme.error}Error:${reset} ${error instanceof Error ? error.message : String(error)}`, ""].join("\n") + "\n");
    },
    info(text) {
      line(`${theme.success}${text}${reset}`);
    },
    async interactive(onInput, options = {}) {
      await runTerminalInputLoop(onInput, { ...options, theme: options.theme ?? theme }, {
        getBusy: () => isBusy,
        getActivityLabel: () => activityLabel,
        suppressWorking: () => suppressWorking,
        hasTransientLines() {
          return Boolean((assistantOpen && hasAssistantContent(streamingAssistantContent)) || activeTools.size > 0);
        },
        getTransientLines() {
          const lines = [];
          if (assistantOpen && hasAssistantContent(streamingAssistantContent)) {
            lines.push(...formatAssistantPreview(streamingAssistantContent, theme));
          }
          for (const toolState of activeTools.values()) {
            lines.push(...renderToolBlock(toolState, theme));
          }
          return lines;
        },
        setRenderers(nextRender, nextClear) {
          renderInput = nextRender;
          clearInput = nextClear;
          inputActive = true;
        },
        clearRenderers() {
          if (renderTimer) {
            clearTimeout(renderTimer);
            renderTimer = undefined;
          }
          clearInput();
          inputActive = false;
          renderInput = () => {};
          clearInput = () => {};
        },
      });
    },
    done() {
      line("");
      line(`${theme.muted}done${reset}`);
    },
    goodbye(status) {
      const sessionComplete = pick(outroMessages.sessionComplete);
      const fromElson = pick(outroMessages.fromElson);
      const technicalLines = formatTechnicalDetails(status);
      line("");
      line(`${theme.primary}${sessionComplete}${reset}`);
      line(`${theme.muted}btw elson says:${reset} ${fromElson}`);
      line("");
      for (const detailLine of technicalLines) {
        line(`${theme.dimMuted}${detailLine}${reset}`);
      }
      return {
        sessionComplete,
        fromElson,
        technicalLines,
        usage: status.usage,
        sessionId: status.sessionId,
        sessionFile: status.sessionFile,
      };
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
  if (update?.type === "text_start" || update?.type === "text_delta" || hasAssistantContent(extractAssistantContent(event.message?.content))) {
    return "writing";
  }
  if (update?.type === "toolcall_start" || update?.type === "toolcall_delta") return "working";
  return "thinking";
}

function formatToolActivity(value) {
  return String(value ?? "tool")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() || "tool";
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatSessionTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatSessionPath(value) {
  const cwd = process.cwd();
  if (value.toLowerCase().startsWith(cwd.toLowerCase())) {
    return `.${value.slice(cwd.length)}`;
  }
  return value;
}

function formatAssistantContent(content, theme = fallbackTheme) {
  const width = assistantContentWidth();
  const lines = [""];
  if (content.text.trim()) {
    const renderedText = trimOuterBlankLines(renderMarkdown(content.text, width));
    lines.push(...renderedText.map((line) => assistantLine(line, theme)));
  }
  return lines;
}

function formatAssistantPreview(content, theme = fallbackTheme) {
  const width = assistantContentWidth();
  const lines = [""];
  const text = content.text.trim();

  if (text) {
    const renderedText = trimOuterBlankLines(renderMarkdown(text, width)).map((line) => assistantLine(line, theme));
    lines.push(...renderedText);
  }

  return lines;
}

function renderToolBlock(toolState, theme = fallbackTheme) {
  const isError = toolState.isError || toolState.state === "error";
  const isDone = toolState.state === "done";
  const stateLabel = isError ? "failed" : isDone ? "succeeded" : "running";
  const title = toolState.toolName ?? "tool";
  const rows = [`${title} ${stateLabel}`];
  const args = summarizeToolArgs(toolState.args);
  if (args) rows.push(...args.flatMap((line) => splitDisplayLines(line)).map((line) => `  ${line}`));
  const outputText = summarizeToolResult(toolState.result);
  if (outputText) {
    rows.push(...outputText.flatMap((line) => splitDisplayLines(line)).map((line) => `  ${line}`));
  }
  return renderToolMessage(rows, { isDone, isError }, theme);
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return [];
  const important = args.path ?? args.filePath ?? args.cwd ?? args.command ?? args.cmd;
  if (typeof important === "string" && important.length > 0) return [truncate(important, 120)];
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${formatToolValue(value)}`);
  return entries;
}

function summarizeToolResult(result) {
  if (!result) return [];
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => item?.text)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).slice(0, 4).map((line) => truncate(line, 120));
}

function formatToolValue(value) {
  if (typeof value === "string") return truncate(value, 80);
  try {
    return truncate(JSON.stringify(value), 80);
  } catch {
    return String(value);
  }
}

function splitDisplayLines(text) {
  return String(text).split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function trimOuterBlankLines(lines) {
  const normalized = lines.map((line) => stripTrailingDisplayPadding(line));
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start].trim().length === 0) start += 1;
  while (end > start && normalized[end - 1].trim().length === 0) end -= 1;
  return normalized.slice(start, end);
}

function stripTrailingDisplayPadding(line) {
  return String(line).replace(/[ \t]+((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/g, "$1");
}

function assistantContentWidth() {
  const terminalWidth = Math.max(24, (output.columns ?? 100) - 1);
  return Math.max(24, terminalWidth - assistantPadding.length);
}

function assistantLine(text) {
  if (!String(text).trim()) return "";
  return `${assistantPadding}${text}`;
}

function renderToolMessage(rows, state, theme = fallbackTheme) {
  const width = Math.max(24, (output.columns ?? 100) - 1);
  const contentWidth = Math.max(1, width);
  const bg = state.isError ? theme.toolErrorBg : state.isDone ? theme.toolSuccessBg : theme.toolBg;
  const fg = theme.toolFg ?? "\x1b[1m\x1b[97m";
  const bgLine = (content = "") => `${bg}${fg}${padDisplay(content, contentWidth)}${reset}`;
  return ["", bgLine(), ...rows.map((row) => bgLine(truncate(row, contentWidth))), bgLine(), ""];
}

function padDisplay(text, width) {
  const value = String(text);
  return `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatUsage(usage = {}) {
  const parts = [
    `total=${formatNumber(usage.total)}`,
    `input=${formatNumber(usage.input)}`,
  ];
  if (usage.cacheRead) {
    parts.push(`(+ ${formatNumber(usage.cacheRead)} cached)`);
  }
  if (usage.cacheWrite) {
    parts.push(`cache write=${formatNumber(usage.cacheWrite)}`);
  }
  if (usage.reasoning) {
    parts.push(`output=${formatNumber(usage.output)} (reasoning ${formatNumber(usage.reasoning)})`);
  } else {
    parts.push(`output=${formatNumber(usage.output)}`);
  }
  return parts.join(" ");
}

function formatTechnicalDetails(status) {
  const lines = [
    "Technical details",
    `  Token usage: ${formatUsage(status.usage)}`,
  ];
  if (status.sessionId && status.sessionFile) {
    lines.push(`  Continue: .\\cara.ps1 resume ${status.sessionId}`);
  }
  if (status.sessionFile) {
    lines.push(`  Session: ${formatSessionPath(status.sessionFile)}`);
  }
  return lines;
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
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

function emptyAssistantContent() {
  return { thinking: "", text: "", hasThinkingBlock: false };
}

function hasAssistantContent(content) {
  return Boolean(content.text.trim());
}

function normalizeAssistantContent(primary, fallback) {
  if (hasAssistantContent(primary)) return primary;
  return fallback;
}

function extractAssistantEventContent(event, current = emptyAssistantContent()) {
  const messageContent = extractAssistantContent(event.message?.content);
  const partialContent = extractAssistantContent(event.assistantMessageEvent?.partial?.content);
  const next = longerAssistantContent(messageContent, partialContent, current);

  if (hasAssistantContent(next) && next !== current) return next;

  const delta = event.assistantMessageEvent;
  if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.length > 0) {
    return { ...current, text: `${current.text}${delta.delta}` };
  }

  return next;
}

function longerAssistantContent(...contents) {
  return contents.reduce((best, content) => {
    if (!hasAssistantContent(content)) return best;
    return content.text.length > best.text.length ? content : best;
  }, emptyAssistantContent());
}

function assistantContentKey(content) {
  return content.text.trim();
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

  return {
    thinking: thinking.join("\n"),
    text: text.join("\n"),
    hasThinkingBlock,
  };
}

export function extractText(content) {
  return extractAssistantContent(content).text;
}
