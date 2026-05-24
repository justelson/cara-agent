import { renderMarkdown } from "../../pi-markdown.mjs";
import { buildTerminalTheme } from "../../terminal-theme.mjs";
import {
  bold,
  normalIntensity,
  padToVisibleWidth,
  reset,
  splitDisplayLines,
  trimOuterBlankLines,
  truncatePlain,
  visibleWidth,
  wrapPlain,
} from "../render-utils.mjs";

const fallbackTheme = buildTerminalTheme();
const assistantPadding = "  ";

export class UserMessageComponent {
  constructor(key, text, theme = fallbackTheme) {
    this.key = key;
    this.text = String(text ?? "");
    this.theme = theme;
  }

  setHost(host) {
    this.host = host;
  }

  render(width) {
    const contentWidth = Math.max(1, width);
    const rows = wrapPlain(`> ${this.text}`, contentWidth);
    const bgLine = (content = "") => `${this.theme.userBg}${this.theme.userFg}${content.padEnd(contentWidth)}${reset}`;
    return ["", bgLine(), ...rows.map((row) => bgLine(row)), bgLine()];
  }
}

export class AssistantMessageComponent {
  constructor(key, content = { text: "" }, theme = fallbackTheme) {
    this.key = key;
    this.content = content;
    this.theme = theme;
    this.final = false;
  }

  setHost(host) {
    this.host = host;
  }

  setContent(content, options = {}) {
    this.content = content;
    this.final = Boolean(options.final ?? this.final);
    this.host?.invalidate();
  }

  render(width) {
    const text = String(this.content?.text ?? "").trim();
    if (!text) return [];
    const contentWidth = Math.max(24, width - assistantPadding.length);
    const rendered = trimOuterBlankLines(renderMarkdown(text, contentWidth, this.theme));
    return ["", ...rendered.map((line) => line.trim() ? `${assistantPadding}${line}` : "")];
  }
}

export class ToolMessageComponent {
  constructor(key, toolState = {}, theme = fallbackTheme) {
    this.key = key;
    this.toolState = toolState;
    this.theme = theme;
    this.spacingKind = "tool";
  }

  setHost(host) {
    this.host = host;
  }

  update(toolState = {}) {
    this.toolState = { ...this.toolState, ...toolState };
    this.host?.invalidate();
  }

  render(width) {
    return renderToolBlock(this.toolState, this.theme, width);
  }
}

export class ActivityComponent {
  constructor(key, getState, theme = fallbackTheme) {
    this.key = key;
    this.getState = getState;
    this.theme = theme;
  }

  setHost(host) {
    this.host = host;
  }

  render() {
    const state = this.getState?.() ?? {};
    if (!state.active || state.suppress) return [];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const frame = Number(state.frame ?? 0);
    const label = String(state.label ?? "working").replace(/\s+/g, " ").trim() || "working";
    return [`  ${this.theme.accent}${frames[frame % frames.length]}${reset} ${this.theme.muted}${label}${reset}`];
  }
}

export function renderToolBlock(toolState, theme = fallbackTheme, width = 100) {
  const resolvedTheme = buildTerminalTheme(theme);
  const isError = toolState.isError || toolState.state === "error";
  const isDone = toolState.state === "done";
  const stateLabel = isError ? "failed" : isDone ? "succeeded" : "running";
  const state = isError ? "error" : isDone ? "done" : "running";
  const title = toolState.toolName ?? "tool";
  const rawArgs = toolState.args ?? toolState.arguments;
  const command = rawArgs && typeof rawArgs === "object" ? firstStringValue(rawArgs, ["command", "cmd"]) : undefined;
  const rows = command
    ? [{ kind: "command", title, state, stateLabel, text: command, rightText: toolCommandStatusText(toolState, { title, state, stateLabel }) }]
    : [{ kind: "title", title, state, stateLabel }];
  const args = summarizeToolArgs(rawArgs, { toolName: title, state, commandAsTitle: Boolean(command) });
  if (args) rows.push(...normalizeToolSummaryRows(args, "args"));
  const outputText = summarizeToolResult(toolState.result ?? toolState.partialResult);
  if (outputText.length > 0) {
    rows.push({ kind: "spacer" });
    rows.push(...outputText.flatMap((line) => splitDisplayLines(line)).map((line) => ({ kind: "output", text: line })));
  }
  const footer = command ? "" : toolFooterText(toolState, { title, state, stateLabel, hasOutput: outputText.length > 0 });
  if (footer) {
    rows.push({ kind: "spacer" });
    rows.push({ kind: state === "error" ? "footerError" : "hint", text: footer });
  } else if (state === "running" && !command) {
    rows.push({ kind: "hint", text: "status started" });
  }
  const terminalWidth = Math.max(24, Number(width) || 100);
  const surface = toolSurfaceForState(state, resolvedTheme);
  const innerBlank = renderToolBlankRow(terminalWidth, surface);
  return [
    "",
    innerBlank,
    ...rows.flatMap((row) => renderToolRow(row, resolvedTheme, terminalWidth, surface)),
    innerBlank,
    "",
  ];
}

export function summarizeToolArgs(args, context = {}) {
  if (!args || typeof args !== "object") return [];
  const toolName = normalizeToolName(context.toolName);
  const rows = [];
  const targetPath = firstStringValue(args, ["path", "filePath", "file_path", "targetPath", "target_file", "filename"]);
  const command = firstStringValue(args, ["command", "cmd"]);
  const isMutation = isFileMutationTool(toolName, args);
  if (targetPath) rows.push(`path ${truncatePlain(targetPath, 116)}`);
  if (command && !context.commandAsTitle) rows.push(`${toolName.includes("bash") ? "cmd " : "run "} ${truncatePlain(command, 116)}`);
  if (isMutation) rows.push(...summarizeMutationArgs(toolName, args));
  if (rows.length > 0) return rows.slice(0, isMutation ? 14 : 7);
  const values = Object.entries(args).filter(([key, value]) => {
    if (context.commandAsTitle && ["command", "cmd"].includes(key)) return false;
    if (context.commandAsTitle && isTimeoutArgKey(key)) return false;
    return value !== undefined && value !== null && value !== "";
  });
  const entries = values.slice(0, 4).map(([key, value]) => `${key}: ${formatToolValue(value)}`);
  if (values.length > entries.length) {
    entries.push(`... ${values.length - entries.length} more arg${values.length - entries.length === 1 ? "" : "s"}`);
  }
  return entries;
}

export function summarizeToolResult(result) {
  if (!result) return [];
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((item) => item?.text).filter(Boolean).join("\n").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const visible = lines.slice(0, 4).map((line) => truncatePlain(line, 120));
  if (lines.length > visible.length) {
    visible.push(`... ${lines.length - visible.length} more output line${lines.length - visible.length === 1 ? "" : "s"}`);
  }
  return visible;
}

function normalizeToolSummaryRows(items = [], fallbackKind = "args") {
  return items.flatMap((item) => {
    if (typeof item === "string") {
      return splitDisplayLines(item).map((line) => ({ kind: fallbackKind, text: line }));
    }
    const kind = item?.kind ?? fallbackKind;
    return splitDisplayLines(item?.text ?? "").map((line) => ({ kind, text: line }));
  });
}

function summarizeMutationArgs(toolName, args = {}) {
  const rows = [];
  const oldText = firstStringValue(args, ["oldString", "old_string", "oldStr", "old_str", "from", "before"]);
  const newText = firstStringValue(args, ["newString", "new_string", "newStr", "new_str", "to", "after"]);
  const content = firstStringValue(args, ["content", "fileContent", "file_content", "text", "body"]);
  const patch = firstStringValue(args, ["patch", "diff"]);
  const edits = Array.isArray(args.edits) ? args.edits : Array.isArray(args.replacements) ? args.replacements : [];

  if (oldText !== undefined || newText !== undefined) {
    rows.push({ kind: "diffMeta", text: `edit replace ${formatTextSize(oldText)} -> ${formatTextSize(newText)}` });
    rows.push(...renderBeforeAfterDiff(oldText, newText));
    return rows;
  }

  if (content !== undefined) {
    const verb = toolName.includes("append") ? "append" : toolName.includes("edit") ? "edit" : "write";
    rows.push({ kind: "diffMeta", text: `${verb} ${formatTextSize(content)}` });
    rows.push(...renderAddedTextDiff(content));
    return rows;
  }

  if (patch !== undefined) {
    rows.push({ kind: "diffMeta", text: `patch ${formatPatchSize(patch)}` });
    rows.push(...renderPatchDiff(patch));
    return rows;
  }

  if (edits.length > 0) {
    rows.push({ kind: "diffMeta", text: `edit ${edits.length} replacement${edits.length === 1 ? "" : "s"}` });
    for (const edit of edits.slice(0, 2)) {
      const editPath = firstStringValue(edit, ["path", "filePath", "file_path"]);
      const editOld = firstStringValue(edit, ["oldString", "old_string", "oldStr", "old_str", "from", "before"]);
      const editNew = firstStringValue(edit, ["newString", "new_string", "newStr", "new_str", "to", "after"]);
      const label = editPath ? truncatePlain(editPath, 42) : "change";
      rows.push({ kind: "diffMeta", text: `${label} ${formatTextSize(editOld)} -> ${formatTextSize(editNew)}` });
      rows.push(...renderBeforeAfterDiff(editOld, editNew, 2));
    }
    if (edits.length > 2) rows.push({ kind: "hint", text: `... ${edits.length - 2} more replacement${edits.length - 2 === 1 ? "" : "s"}` });
  }

  return rows;
}

function renderBeforeAfterDiff(oldText = "", newText = "", maxLines = 3) {
  const rows = [];
  const before = previewLines(oldText, maxLines);
  const after = previewLines(newText, maxLines);
  if (before.length > 0) {
    rows.push({ kind: "diffMeta", text: "--- before" });
    rows.push(...before.map((line) => ({ kind: "diffRemove", text: line })));
  }
  if (after.length > 0) {
    rows.push({ kind: "diffMeta", text: "+++ after" });
    rows.push(...after.map((line) => ({ kind: "diffAdd", text: line })));
  }
  return rows;
}

function renderAddedTextDiff(text = "", maxLines = 5) {
  const lines = previewLines(text, maxLines);
  if (lines.length === 0) return [];
  return [
    { kind: "diffMeta", text: "+++ content" },
    ...lines.map((line) => ({ kind: "diffAdd", text: line })),
  ];
}

function renderPatchDiff(patch = "", maxLines = 8) {
  const lines = String(patch ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, maxLines);
  return lines.map((line) => {
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) return { kind: "diffMeta", text: line };
    if (line.startsWith("+")) return { kind: "diffAdd", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "diffRemove", text: line.slice(1) };
    return { kind: "diffContext", text: line.trimStart() };
  });
}

function previewLines(value = "", maxLines = 4) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .map((line) => truncatePlain(line, 96));
}

function isFileMutationTool(toolName, args = {}) {
  if (/(edit|write|patch|replace|append|create)/i.test(toolName)) return true;
  return Boolean(
    firstStringValue(args, ["oldString", "old_string", "oldStr", "old_str", "newString", "new_string", "newStr", "new_str"])
    || firstStringValue(args, ["content", "fileContent", "file_content", "patch", "diff"]),
  );
}

function firstStringValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isTimeoutArgKey(key) {
  return ["timeout", "timeoutMs", "timeout_ms", "timeoutSeconds", "timeout_seconds"].includes(key);
}

function normalizeToolName(value) {
  return String(value ?? "tool").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function formatTextSize(value = "") {
  const text = String(value ?? "");
  const lineCount = text.length ? text.split(/\r?\n/).length : 0;
  const byteCount = Buffer.byteLength(text, "utf8");
  if (lineCount > 1) return `${lineCount} lines/${formatBytes(byteCount)}`;
  return `${byteCount}b`;
}

function formatPatchSize(value = "") {
  const lines = String(value ?? "").split(/\r?\n/);
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  if (added || removed) return `+${added}/-${removed}`;
  return formatTextSize(value);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value}b`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)}kb`;
}

function formatToolValue(value) {
  if (typeof value === "string") return truncatePlain(value, 80);
  try {
    return truncatePlain(JSON.stringify(value), 80);
  } catch {
    return String(value);
  }
}

function toolFooterText(toolState = {}, context = {}) {
  const timing = formatToolElapsed(toolState);
  if (timing && context.state === "running") {
    return `${String(context.title ?? "tool").replace(/\s+/g, " ").trim() || "tool"} running ${timing}`;
  }
  if (timing) return `${timing} ${context.stateLabel ?? context.state ?? ""}`.trim();
  if (context.state === "running" && !context.hasOutput) return "status started";
  return "";
}

function toolCommandStatusText(toolState = {}, context = {}) {
  const elapsed = formatToolElapsed(toolState, { running: context.state === "running" });
  const timeout = formatToolTimeout(toolState);
  const pieces = [];
  if (context.state === "running") {
    pieces.push(`${String(context.title ?? "tool").replace(/\s+/g, " ").trim() || "tool"} running${elapsed ? ` ${elapsed}` : ""}`);
  } else {
    pieces.push(`${elapsed ? `${elapsed} ` : ""}${context.stateLabel ?? context.state ?? ""}`.trim());
  }
  if (timeout) pieces.push(`(${timeout})`);
  return pieces.filter(Boolean).join(" ");
}

function formatToolElapsed(toolState = {}, options = {}) {
  const durationMs = numericMilliseconds(toolState.durationMs)
    ?? numericMilliseconds(toolState.elapsedMs)
    ?? numericMilliseconds(toolState.executionTimeMs)
    ?? numericMilliseconds(toolState.result?.durationMs)
    ?? numericMilliseconds(toolState.result?.elapsedMs)
    ?? numericSeconds(toolState.durationSeconds)
    ?? numericSeconds(toolState.elapsedSeconds)
    ?? durationBetween(toolState.startedAt, toolState.endedAt ?? toolState.completedAt)
    ?? (options.running ? durationBetween(toolState.startedAt, Date.now()) : undefined);
  if (durationMs === undefined) return "";
  return formatDuration(durationMs);
}

function formatToolTimeout(toolState = {}) {
  const args = toolState.args ?? toolState.arguments ?? {};
  const timeoutMs = numericMilliseconds(toolState.timeoutMs)
    ?? numericMilliseconds(args.timeoutMs)
    ?? numericMilliseconds(args.timeout_ms)
    ?? numericSeconds(toolState.timeoutSeconds)
    ?? numericSeconds(args.timeoutSeconds)
    ?? numericSeconds(args.timeout_seconds)
    ?? flexibleDuration(toolState.timeout)
    ?? flexibleDuration(args.timeout);
  if (timeoutMs === undefined) return "";
  return `timeout ${formatDuration(timeoutMs)}`;
}

function numericMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function numericSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number * 1000;
}

function flexibleDuration(value) {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|secs|second|seconds)?$/);
    if (!match) return undefined;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 0) return undefined;
    return match[2] === "ms" ? number : number * 1000;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number <= 600 ? number * 1000 : number;
}

function durationBetween(start, end) {
  const started = parseTimestamp(start);
  const ended = parseTimestamp(end);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function toolRowColor(kind, theme = fallbackTheme) {
  if (kind === "command") return theme.toolTitleFg ?? theme.toolFg ?? `${bold}\x1b[97m`;
  if (kind === "title") return theme.toolTitleFg ?? theme.toolFg ?? `${bold}\x1b[97m`;
  if (kind === "args") return theme.toolArgsFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "output") return theme.toolOutputFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "diffAdd") return theme.toolDiffAddFg ?? theme.success ?? theme.toolFg ?? "\x1b[92m";
  if (kind === "diffRemove") return theme.toolDiffRemoveFg ?? theme.error ?? theme.toolFg ?? "\x1b[91m";
  if (kind === "diffMeta") return theme.toolDiffMetaFg ?? theme.toolDimFg ?? theme.toolHintFg ?? "\x1b[38;5;245m";
  if (kind === "diffContext") return theme.toolDiffContextFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "footerError") return theme.toolStateErrorFg ?? theme.error ?? theme.toolHintFg ?? "\x1b[38;5;245m";
  if (kind === "hint") return theme.toolHintFg ?? theme.toolFg ?? "\x1b[38;5;245m";
  return theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
}

function renderToolBlankRow(width = 100, surface = "") {
  return `${surface}${" ".repeat(width)}${reset}`;
}

function renderToolRow(row, theme = fallbackTheme, width = 100, surface = theme.toolBg) {
  if (row.kind === "spacer") return renderToolBlankRow(width, surface);
  const marker = toolRowMarker(row);
  const markerColor = toolMarkerColor(row, theme);
  const prefix = toolRowPrefix(row, marker, markerColor);
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  if (row.kind === "command") {
    const rightText = String(row.rightText ?? "").trim();
    const maxRightWidth = Math.max(8, Math.floor(contentWidth * 0.48));
    const visibleRight = rightText ? truncatePlain(rightText, maxRightWidth) : "";
    const right = visibleRight ? `${toolStatusColor(row.state, theme)}${visibleRight}` : "";
    const gap = right ? 2 : 0;
    const leftWidth = Math.max(1, contentWidth - visibleWidth(right) - gap);
    const color = toolRowColor(row.kind, theme);
    const wrapped = wrapCodeRow(row.text ?? "", leftWidth);
    const firstLeft = `${prefix}${color}${wrapped[0] ?? ""}`;
    const spaces = right ? " ".repeat(Math.max(1, width - visibleWidth(firstLeft) - visibleWidth(right))) : "";
    const lines = [`${surface}${padToVisibleWidth(`${firstLeft}${spaces}${right}`, width)}${reset}`];
    const continuationPrefix = "  ";
    const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
    for (const rawLine of wrapped.slice(1)) {
      for (const line of wrapCodeRow(rawLine, continuationWidth)) {
        const content = `${continuationPrefix}${color}${line}`;
        lines.push(`${surface}${padToVisibleWidth(content, width)}${reset}`);
      }
    }
    return lines;
  }
  const rowContent = row.kind === "title"
    ? `${prefix}${renderToolTitle(row, theme, contentWidth)}`
    : `${prefix}${toolRowColor(row.kind, theme)}${truncatePlain(row.text ?? "", contentWidth)}`;
  return `${surface}${padToVisibleWidth(rowContent, width)}${reset}`;
}

function wrapCodeRow(text, width = 80) {
  const max = Math.max(1, Number(width) || 1);
  const lines = String(text ?? "").split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line) {
      rows.push("");
      continue;
    }
    for (let index = 0; index < line.length; index += max) {
      rows.push(line.slice(index, index + max));
    }
  }
  return rows.length ? rows : [""];
}

function toolRowMarker(row) {
  if (row.kind === "title" && row.state === "error") return "!";
  if (row.kind === "title") return ">";
  if (row.kind === "command") return "$";
  if (row.kind === "diffAdd") return "+";
  if (row.kind === "diffRemove") return "-";
  if (row.kind === "diffContext") return " ";
  if (row.kind === "diffMeta" || row.kind === "args") return "|";
  return "";
}

function toolMarkerColor(row, theme = fallbackTheme) {
  if (row.kind === "diffAdd") return theme.toolDiffAddFg ?? theme.success ?? theme.toolRailFg;
  if (row.kind === "diffRemove") return theme.toolDiffRemoveFg ?? theme.error ?? theme.toolRailFg;
  if (row.kind === "title" || row.kind === "command") return theme.toolMarkerFg;
  return theme.toolRailFg;
}

function toolStatusColor(state, theme = fallbackTheme) {
  if (state === "error") return theme.toolStateErrorFg ?? theme.error ?? theme.toolHintFg;
  if (state === "done") return theme.toolStateSuccessFg ?? theme.success ?? theme.toolHintFg;
  return theme.toolStateRunningFg ?? theme.warning ?? theme.toolHintFg;
}

function toolRowPrefix(row, marker, markerColor) {
  if (!marker) return "  ";
  return `  ${markerColor}${marker} `;
}

function toolSurfaceForState(state, theme = fallbackTheme) {
  if (state === "error") return theme.toolErrorBg || theme.toolBg || "";
  if (state === "done") return theme.toolSuccessBg || theme.toolBg || "";
  return theme.toolBg || "";
}

function renderToolTitle(row, theme = fallbackTheme, width = 80) {
  const title = String(row.title ?? "tool").replace(/\s+/g, " ").trim() || "tool";
  const stateLabel = String(row.stateLabel ?? "running");
  const fullTitle = `${title} ${stateLabel}`;
  if (fullTitle.length > width) {
    return `${theme.toolTitleFg}${truncatePlain(fullTitle, width)}${normalIntensity}`;
  }
  return `${theme.toolNameFg}${title}${normalIntensity} ${toolStateColor(row.state, theme)}${stateLabel}`;
}

function toolStateColor(state, theme = fallbackTheme) {
  if (state === "error") return theme.toolStateErrorFg ?? theme.error;
  if (state === "done") return theme.toolStateSuccessFg ?? theme.success;
  return theme.toolStateRunningFg ?? theme.warning;
}
