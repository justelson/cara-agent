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
  const rows = [{ kind: "title", title, state, stateLabel }];
  const args = summarizeToolArgs(toolState.args ?? toolState.arguments, { toolName: title, state });
  if (args) rows.push(...normalizeToolSummaryRows(args, "args"));
  const outputText = summarizeToolResult(toolState.result ?? toolState.partialResult);
  if (outputText.length > 0) {
    rows.push(...outputText.flatMap((line) => splitDisplayLines(line)).map((line) => ({ kind: "output", text: line })));
  } else if (state === "running") {
    rows.push({ kind: "hint", text: "status started" });
  }
  const terminalWidth = Math.max(24, Number(width) || 100);
  const surface = toolSurfaceForState(state, resolvedTheme);
  return ["", ...rows.map((row) => renderToolRow(row, resolvedTheme, terminalWidth, surface)), ""];
}

export function summarizeToolArgs(args, context = {}) {
  if (!args || typeof args !== "object") return [];
  const toolName = normalizeToolName(context.toolName);
  const rows = [];
  const targetPath = firstStringValue(args, ["path", "filePath", "file_path", "targetPath", "target_file", "filename"]);
  const command = firstStringValue(args, ["command", "cmd"]);
  const isMutation = isFileMutationTool(toolName, args);
  if (targetPath) rows.push(`path ${truncatePlain(targetPath, 116)}`);
  if (command) rows.push(`${toolName.includes("bash") ? "cmd " : "run "} ${truncatePlain(command, 116)}`);
  if (isMutation) rows.push(...summarizeMutationArgs(toolName, args));
  if (rows.length > 0) return rows.slice(0, isMutation ? 14 : 7);
  const values = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== "");
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

function toolRowColor(kind, theme = fallbackTheme) {
  if (kind === "title") return theme.toolTitleFg ?? theme.toolFg ?? `${bold}\x1b[97m`;
  if (kind === "args") return theme.toolArgsFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "output") return theme.toolOutputFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "diffAdd") return theme.toolDiffAddFg ?? theme.success ?? theme.toolFg ?? "\x1b[92m";
  if (kind === "diffRemove") return theme.toolDiffRemoveFg ?? theme.error ?? theme.toolFg ?? "\x1b[91m";
  if (kind === "diffMeta") return theme.toolDiffMetaFg ?? theme.toolDimFg ?? theme.toolHintFg ?? "\x1b[38;5;245m";
  if (kind === "diffContext") return theme.toolDiffContextFg ?? theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
  if (kind === "hint") return theme.toolHintFg ?? theme.toolFg ?? "\x1b[38;5;245m";
  return theme.toolDetailFg ?? theme.toolFg ?? "\x1b[97m";
}

function renderToolRow(row, theme = fallbackTheme, width = 100, surface = theme.toolBg) {
  const marker = toolRowMarker(row);
  const markerColor = toolMarkerColor(row, theme);
  const prefix = `  ${markerColor}${marker} `;
  const contentWidth = Math.max(1, width - 4);
  const rowContent = row.kind === "title"
    ? `${prefix}${renderToolTitle(row, theme, contentWidth)}`
    : `${prefix}${toolRowColor(row.kind, theme)}${truncatePlain(row.text ?? "", contentWidth)}`;
  return `${surface}${padToVisibleWidth(rowContent, width)}${reset}`;
}

function toolRowMarker(row) {
  if (row.kind === "title" && row.state === "error") return "!";
  if (row.kind === "title") return ">";
  if (row.kind === "diffAdd") return "+";
  if (row.kind === "diffRemove") return "-";
  if (row.kind === "diffContext") return " ";
  return "|";
}

function toolMarkerColor(row, theme = fallbackTheme) {
  if (row.kind === "diffAdd") return theme.toolDiffAddFg ?? theme.success ?? theme.toolRailFg;
  if (row.kind === "diffRemove") return theme.toolDiffRemoveFg ?? theme.error ?? theme.toolRailFg;
  if (row.kind === "title") return theme.toolMarkerFg;
  return theme.toolRailFg;
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
