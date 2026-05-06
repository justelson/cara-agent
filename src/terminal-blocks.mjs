import { buildTerminalTheme } from "./terminal-theme.mjs";

const bold = "\x1b[1m";
const reset = "\x1b[0m";
const fallbackTheme = buildTerminalTheme();

export function renderProgressBox(progress = {}, theme = fallbackTheme, terminalColumns = 100) {
  const width = Math.max(56, Math.min(92, Number(terminalColumns || 100) - 1));
  const contentWidth = width - 4;
  const percent = clamp(Number(progress.percent) || 0, 0, 100);
  const rows = [
    `${bold}${theme.primary}${progress.title ?? "Working"}${reset} ${theme.muted}${formatPercent(percent)}${reset}`,
    `${theme.warning}${truncatePlain(progress.label ?? "working", 26).padEnd(26)}${reset} ${progressBar(percent, theme)}`,
    `${theme.muted}${truncatePlain(progress.detail ?? "reading project", contentWidth)}${reset}`,
  ];
  const border = `${theme.primary}+${"-".repeat(width - 2)}+${reset}`;
  return [
    "",
    border,
    ...rows.map((row) => boxedStatusLine(row, contentWidth, theme)),
    border,
    "",
  ];
}

export function renderStatusBox(status = {}, theme = fallbackTheme, terminalColumns = 100) {
  const width = Math.max(64, Math.min(112, Number(terminalColumns || 100) - 1));
  const contentWidth = Math.max(24, width - 4);
  const valueWidth = Math.max(16, contentWidth - 10);
  const rows = [
    `${bold}${theme.primary}Cara status${reset} ${theme.muted}${status.sessionName ? status.sessionName : "live session"}${reset}`,
    renderContextLine(status, theme),
    "",
    statusField("project", status.project, theme, valueWidth),
    statusField("model", status.model, theme, valueWidth),
    statusField("profile", `${status.profile ?? "auto"}  thinking ${status.thinking ?? "off"}`, theme, valueWidth),
    statusField("chat", status.sessionId, theme, valueWidth),
    statusField("file", status.sessionFile, theme, valueWidth),
    statusField("sessions", status.sessions, theme, valueWidth),
  ];

  if (status.projectMemory?.length) {
    rows.push(statusField("memory", status.projectMemory.join(", "), theme, valueWidth));
  }
  if (status.customCommands?.length) {
    rows.push(statusField("commands", status.customCommands.map((command) => `/${command.name}`).join(", "), theme, valueWidth));
  }

  const border = `${theme.primary}+${"-".repeat(width - 2)}+${reset}`;
  const divider = `${theme.primary}|${reset}${theme.muted}${"-".repeat(width - 2)}${reset}${theme.primary}|${reset}`;
  return [
    "",
    border,
    ...rows.flatMap((row) => row === "" ? [divider] : wrapStatusRow(row, contentWidth).map((line) => boxedStatusLine(line, contentWidth, theme))),
    border,
    "",
  ];
}

export function renderRetryBlock(event, theme = fallbackTheme, terminalColumns = 100) {
  const width = Math.max(24, Number(terminalColumns || 100) - 1);
  const contentWidth = Math.max(1, width);
  const attempt = event.attempt ?? "?";
  const maxAttempts = event.maxAttempts ?? "?";
  const title = `retry ${attempt}/${maxAttempts}`;
  const message = formatRetryErrorMessage(event.errorMessage ?? event.error ?? "request failed; retrying");
  const rows = [`${title}: ${message}`].flatMap((row) => wrapPlain(row, contentWidth));
  const rule = `${theme.error}${"-".repeat(contentWidth)}${reset}`;
  const bgLine = (content = "") => `${theme.toolErrorBg}${theme.toolFg}${padDisplay(truncatePlain(content, contentWidth), contentWidth)}${reset}`;
  return ["", rule, ...rows.map((row) => bgLine(row)), ""];
}

function progressBar(percent, theme = fallbackTheme) {
  const width = 24;
  const value = clamp(Number(percent) || 0, 0, 100);
  const filled = Math.round((value / 100) * width);
  const color = value >= 90 ? theme.success : value >= 55 ? theme.accent : theme.warning;
  return `[${color}${"#".repeat(filled)}${theme.muted}${"-".repeat(width - filled)}${reset}]`;
}

function statusField(label, value, theme = fallbackTheme, valueWidth = 80) {
  return `${theme.warning}${label.padEnd(8)}${reset} ${truncatePlain(String(value ?? "none"), valueWidth)}`;
}

function renderContextLine(status = {}, theme = fallbackTheme) {
  const usage = status.usage ?? {};
  const context = status.contextUsage ?? {};
  const percent = typeof context.percent === "number" && Number.isFinite(context.percent) ? clamp(context.percent, 0, 100) : undefined;
  const used = percent ?? (usage.total ? 0 : 0);
  const left = percent === undefined ? undefined : Math.max(0, 100 - used);
  const label = percent === undefined
    ? "context use unknown"
    : `${formatPercent(used)} used / ${formatPercent(left)} left`;
  return `${theme.accent}${"context ".padEnd(8)}${reset} ${contextBar(used, theme)} ${label}  tokens ${formatNumber(usage.total)}`;
}

function contextBar(percent, theme = fallbackTheme) {
  const width = 26;
  const value = clamp(Number(percent) || 0, 0, 100);
  const filled = Math.round((value / 100) * width);
  const color = value >= 90 ? theme.error : value >= 70 ? theme.warning : theme.success;
  return `[${color}${"#".repeat(filled)}${theme.muted}${"-".repeat(width - filled)}${reset}]`;
}

function boxedStatusLine(text, contentWidth, theme = fallbackTheme) {
  return `${theme.primary}|${reset} ${padDisplay(truncateVisible(text, contentWidth), contentWidth)} ${theme.primary}|${reset}`;
}

function wrapStatusRow(text, width) {
  const raw = stripAnsi(String(text ?? ""));
  if (raw.length <= width) return [text];

  const indent = " ".repeat(9);
  const firstWidth = Math.max(12, width);
  const restWidth = Math.max(12, width - indent.length);
  const words = raw.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const targetWidth = lines.length === 0 ? firstWidth : restWidth;
    const next = current ? `${current} ${word}` : word;
    if (next.length > targetWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= 1) return lines;
  return [lines[0], ...lines.slice(1).map((line) => `${indent}${line}`)];
}

function wrapPlain(text, width) {
  const maxWidth = Math.max(1, width);
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];

  const lines = [];
  let current = "";
  for (const word of words) {
    if (stripAnsi(word).length > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += maxWidth) {
        lines.push(word.slice(index, index + maxWidth));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (stripAnsi(next).length > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function formatRetryErrorMessage(value) {
  const text = String(value ?? "").trim();
  if (!text) return "request failed; retrying";

  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return text;

  try {
    const prefix = text.slice(0, jsonStart).trim().replace(/:\s*$/, "");
    const parsed = JSON.parse(text.slice(jsonStart));
    const message = parsed?.error?.message ?? parsed?.message;
    const code = parsed?.error?.code ?? parsed?.code;
    const parts = [prefix, message, code ? `(${code})` : ""].filter(Boolean);
    return parts.length ? parts.join(" ") : text;
  } catch {
    return text;
  }
}

function truncateVisible(text, max) {
  const value = String(text ?? "");
  if (stripAnsi(value).length <= max) return value;
  const plain = stripAnsi(value);
  return `${plain.slice(0, Math.max(0, max - 3))}...`;
}

function truncatePlain(value, max) {
  return String(value).length > max ? `${String(value).slice(0, Math.max(0, max - 3))}...` : String(value);
}

function padDisplay(text, width) {
  const value = String(text);
  return `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "?%";
  return number >= 10 ? `${number.toFixed(0)}%` : `${number.toFixed(1)}%`;
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
