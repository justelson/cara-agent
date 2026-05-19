import { stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import { renderMarkdown } from "./pi-markdown.mjs";
import { renderAccountStatusBox, renderCodexUsageBox, renderProgressBox, renderRetryBlock, renderStatusBox } from "./terminal-blocks.mjs";
import { runTerminalInputLoop } from "./terminal-input.mjs";
import { applyTerminalTheme, buildTerminalTheme } from "./terminal-theme.mjs";

const bold = "\x1b[1m";
const reset = "\x1b[0m";
const fallbackTheme = buildTerminalTheme();
const assistantPadding = "  ";
const outroMessages = loadJson("./outro-messages.json", {
  sessionComplete: ["another great coding session complete... or not, who knows"],
  fromElson: ["I am always rooting for her."],
});

export function createCaraUi(options = {}) {
  const theme = buildTerminalTheme(options.terminalTheme ?? options.theme);
  let lastAssistantText = "";
  let streamingAssistantContent = emptyAssistantContent();
  let directAssistantText = "";
  let assistantOpen = false;
  const activeTools = new Map();
  let isBusy = false;
  let inputActive = false;
  let renderInput = () => {};
  let clearInput = () => {};
  let renderTimer = undefined;
  let suppressWorking = false;
  let activityLabel = "";
  let progressBox = null;

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

  function beginProgressBox(title = "Working") {
    progressBox = {
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
    flushInputRender();
  }

  function updateProgressBox(next = {}) {
    if (!progressBox) return;
    progressBox = {
      ...progressBox,
      ...next,
      percent: clamp(Number(next.percent ?? progressBox.percent) || 0, 0, 100),
    };
    requestInputRender();
  }

  function finishProgressBox() {
    if (!progressBox) return;
    progressBox = null;
    requestInputRender();
  }

  function beginAssistant() {
    if (assistantOpen) return;
    suppressWorking = false;
    activityLabel = "thinking";
    assistantOpen = true;
    streamingAssistantContent = emptyAssistantContent();
    directAssistantText = "";
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
    const delta = event.assistantMessageEvent;
    if (!inputActive && delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.length > 0) {
      beginAssistant();
      activityLabel = "writing";
      directAssistantText = mergeAssistantTextDelta(directAssistantText, delta.delta);
      streamingAssistantContent = { ...streamingAssistantContent, text: directAssistantText };
      write(delta.delta);
      return;
    }

    const next = extractAssistantEventContent(event, streamingAssistantContent);
    if (!hasAssistantContent(next)) return;
    beginAssistant();
    activityLabel = activityFromAssistantEvent(event);
    streamingAssistantContent = next;
    if (progressBox) {
      updateProgressBox({
        done: false,
        label: "writing",
        detail: "turning the scan into the start note",
        percent: Math.max(progressBox.percent, 88),
      });
    } else {
      requestInputRender();
    }
  }

  function finishAssistant(content) {
    cancelInputRender();
    const finalContent = normalizeAssistantContent(extractAssistantContent(content), streamingAssistantContent);
    const finalKey = assistantContentKey(finalContent);
    const directKey = directAssistantText.trim();
    streamingAssistantContent = emptyAssistantContent();
    assistantOpen = false;
    activityLabel = "writing";
    suppressWorking = true;

    if (directKey) {
      if (!directAssistantText.endsWith("\n")) write("\n");
      lastAssistantText = finalKey || directKey;
      directAssistantText = "";
      renderInput();
      return;
    }

    directAssistantText = "";
    if (!finalKey || finalKey === lastAssistantText) {
      renderInput();
      return;
    }
    if (progressBox) progressBox.done = true;
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

    if (progressBox) {
      updateProgressBox(progressPatchFromTool(progressBox, next, state));
      return;
    }

    if (state === "running") {
      suppressWorking = false;
      activityLabel = activityFromTool(next);
      activeTools.set(toolCallId, next);
      requestInputRender();
      return;
    }

    cancelInputRender();
    activeTools.delete(toolCallId);
    activityLabel = activeTools.size > 0 ? activityFromTool(activeTools.values().next().value) : "thinking";
    print(renderToolBlock(next, theme).join("\n"));
  }

  return {
    banner(status = {}) {
      const project = status.project ?? options.project ?? process.cwd();
      const model = status.model ?? options.model ?? "loading";
      const thinking = status.thinking ?? options.thinking ?? "medium";
      const themeName = status.terminalTheme ?? theme.name ?? "theme";
      line(`${theme.accent}✦${reset} ${bold}${theme.primary}Cara${reset}`);
      line(`   ${theme.muted}${project}${reset}`);
      line(`   ${theme.info}${model}${reset} ${theme.muted}·${reset} ${theme.warning}${thinking}${reset} ${theme.muted}·${reset} ${theme.accent}${themeName}${reset}`);
      line("");
      line(`   ${theme.primary}/start${reset} ${theme.muted}to orient ·${reset} ${theme.accent}/themes${reset} ${theme.muted}to change the room ·${reset} ${theme.success}@file${reset} ${theme.muted}to bring context${reset}`);
      line("");
    },
    commands() {
      line(`
${bold}Slash commands${reset}
  /commands             show this list
  cara auth             show account, plan, and Codex limits
  cara account          same as cara auth
  cara codexusage       show current Codex quota usage
  cara login            login with ChatGPT Plus/Pro via Pi auth
  cara logout           clear stored ChatGPT/Codex auth
  -p, --print "..."     print one answer and exit
  --model <provider/model>
                       choose model for startup or print
  --profile <name>     auto, elson, cara
  --theme <name>       choose terminal theme on startup
  /start                ask the agent for the project starting point
  /status               show project, model, and thinking
  /profile              show active profile
  /profile <name>       auto, elson, cara
  /auth                 show account, plan, and Codex limits
  /account              same as /auth
  /codexusage           show current Codex quota usage
  /login                login with ChatGPT Plus/Pro via Pi auth
  /logout               clear stored ChatGPT/Codex login
  /thinking             cycle thinking effort
  /thinking <level>     off, minimal, low, medium, high, xhigh
  /themes               list terminal themes
  /themes <name>        switch theme for this chat
  /models               open model picker
  /models <provider/model>
  @file                 search and attach project files in prompts
  /session              show current chat file, messages, tokens, cost
  /memory               summarize what Cara memory knows
  /consolidate          clean and update Cara memory layers
  /reload               reload Cara from disk and resume this chat
  /reload --soft        reload commands, themes, prompt, memory only
  /<custom>             run .cara/commands/<custom>.md
  /exit                 leave
  /quit                 leave`);
    },
    status(status) {
      print(`${renderStatusBox(status, theme, output.columns).join("\n")}\n`);
    },
    account(account) {
      print(`${renderAccountStatusBox(account, theme, output.columns).join("\n")}\n`);
    },
    codexUsage(stats) {
      print(`${renderCodexUsageBox(stats, theme, output.columns).join("\n")}\n`);
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
        write(`\r${padDisplay(text, width())}`);
      };
      line("");
      render();
      const timer = setInterval(render, 120);
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        write(`\r${" ".repeat(width())}\r`);
      };
    },
    beginProgress(title) {
      beginProgressBox(title);
    },
    endProgress() {
      finishProgressBox();
    },
    memory(status) {
      const overview = status.memoryOverview ?? ["What I know about Cara", "  Nothing stable yet."];
      const commands = status.customCommands ?? [];
      line("");
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
    sessionInfo(info = {}) {
      const messages = info.messages ?? {};
      const tokens = info.tokens ?? {};
      const cost = info.cost ?? {};
      line("");
      line(`${bold}${theme.primary}Session Info${reset}`);
      line("");
      line(` ${theme.warning}File:${reset} ${theme.muted}${info.file ?? "in-memory"}${reset}`);
      line(` ${theme.warning}ID:${reset} ${theme.muted}${info.id ?? "none"}${reset}`);
      line("");
      line(`${bold} Messages${reset}`);
      line(` User: ${formatCount(messages.user)}`);
      line(` Assistant: ${formatCount(messages.assistant)}`);
      line(` Tool Calls: ${formatCount(messages.toolCalls)}`);
      line(` Tool Results: ${formatCount(messages.toolResults)}`);
      line(` Total: ${formatCount(messages.total)}`);
      line("");
      line(`${bold} Tokens${reset}`);
      line(` Input: ${formatCount(tokens.input)}`);
      line(` Output: ${formatCount(tokens.output)}`);
      line(` Cache Read: ${formatCount(tokens.cacheRead)}`);
      line(` Total: ${formatCount(tokens.total)}`);
      line("");
      line(`${bold} Cost${reset}`);
      line(` Total: ${formatCostValue(cost.total)}`);
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
        print(renderRetryBlock(event, theme, output.columns).join("\n"));
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
      line("");
      line(`${theme.success}${text}${reset}`);
    },
    block(lines = []) {
      const text = Array.isArray(lines) ? lines.join("\n") : String(lines ?? "");
      print(`${text.endsWith("\n") ? text : `${text}\n`}`);
    },
    setTheme(nextTheme) {
      applyTerminalTheme(theme, nextTheme);
      flushInputRender();
    },
    themes(themes, activeName) {
      line("");
      line(`${bold}Themes${reset}`);
      for (const item of themes) {
        const active = item.name === activeName ? `${theme.success}*${reset}` : " ";
        const source = item.source ? ` ${theme.muted}${item.source}${reset}` : "";
        line(` ${active} ${theme.primary}${item.name}${reset} ${theme.muted}${item.displayName ?? item.description ?? ""}${reset}${source}`);
      }
    },
    async interactive(onInput, options = {}) {
      await runTerminalInputLoop(onInput, { ...options, theme }, {
        getBusy: () => isBusy,
        getActivityLabel: () => activityLabel,
        suppressWorking: () => suppressWorking,
        hasTransientLines() {
          return Boolean(
            (progressBox && !progressBox.done) ||
            activeTools.size > 0 ||
            (assistantOpen && hasAssistantContent(streamingAssistantContent))
          );
        },
        getTransientLines() {
          if (progressBox && !progressBox.done) {
            return renderProgressBox(progressBox, theme, output.columns);
          }
          const lines = [];
          for (const toolState of activeTools.values()) {
            lines.push(...renderToolBlock(toolState, theme));
          }
          if (lines.length > 0) return lines;
          if (assistantOpen && hasAssistantContent(streamingAssistantContent)) {
            return formatAssistantContent(streamingAssistantContent, theme);
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
      line("");
      line(`${theme.primary}${sessionComplete}${reset}`);
      line(`${theme.muted}btw elson says:${reset} ${fromElson}`);
      return {
        sessionComplete,
        fromElson,
        technicalLines: [],
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
  if (update?.type === "toolcall_start" || update?.type === "toolcall_delta") return activityFromTool(update);
  return "thinking";
}

function formatToolActivity(value) {
  return String(value ?? "tool")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() || "tool";
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

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatCount(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function formatCostValue(value) {
  return Number(value || 0).toFixed(4);
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
    const renderedText = trimOuterBlankLines(renderMarkdown(content.text, width, theme));
    lines.push(...renderedText.map((line) => assistantLine(line, theme)));
  }
  return lines;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderToolBlock(toolState, theme = fallbackTheme) {
  const isError = toolState.isError || toolState.state === "error";
  const isDone = toolState.state === "done";
  const stateLabel = isError ? "failed" : isDone ? "succeeded" : "running";
  const title = toolState.toolName ?? "tool";
  const rows = [
    { kind: "title", text: `${title} ${stateLabel}` },
    { kind: "hint", text: "summary ..." },
  ];
  const args = summarizeToolArgs(toolState.args);
  if (args) rows.push(...args.flatMap((line) => splitDisplayLines(line)).map((line) => ({ kind: "detail", text: `  ${line}` })));
  const outputText = summarizeToolResult(toolState.result);
  if (outputText) {
    rows.push(...outputText.flatMap((line) => splitDisplayLines(line)).map((line) => ({ kind: "detail", text: `  ${line}` })));
  }
  return renderToolMessage(rows, { isDone, isError }, theme);
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return [];
  const important = args.path ?? args.filePath ?? args.command ?? args.cmd ?? args.cwd;
  if (typeof important === "string" && important.length > 0) return [truncate(important, 120)];
  const values = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "");
  const entries = values
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${formatToolValue(value)}`);
  if (values.length > entries.length) {
    entries.push(`... ${values.length - entries.length} more arg${values.length - entries.length === 1 ? "" : "s"}`);
  }
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
  const lines = text.split(/\r?\n/).filter(Boolean);
  const visible = lines.slice(0, 4).map((line) => truncate(line, 120));
  if (lines.length > visible.length) {
    visible.push(`... ${lines.length - visible.length} more output line${lines.length - visible.length === 1 ? "" : "s"}`);
  }
  return visible;
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
  const bgLine = (row = "") => {
    const item = typeof row === "string" ? { kind: "detail", text: row } : row;
    const color = toolRowColor(item.kind, theme);
    const content = truncate(item.text ?? "", contentWidth);
    return `${bg}${color}${padDisplay(content, contentWidth)}${reset}`;
  };
  return ["", bgLine(), ...rows.map((row) => bgLine(row)), bgLine(), ""];
}

function toolRowColor(kind, theme = fallbackTheme) {
  if (kind === "title") return theme.toolTitleFg ?? theme.toolFg ?? "\x1b[1m\x1b[97m";
  if (kind === "hint") return theme.toolHintFg ?? theme.toolFg ?? "\x1b[38;5;245m";
  return theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
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

  if (hasAssistantContent(next) && assistantContentKey(next) !== assistantContentKey(current)) return next;

  const delta = event.assistantMessageEvent;
  if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.length > 0) {
    return { ...current, text: mergeAssistantTextDelta(current.text, delta.delta) };
  }

  return next;
}

function mergeAssistantTextDelta(currentText, deltaText) {
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
