import { buildTerminalTheme } from "../../terminal-theme.mjs";
import {
  renderAccountStatusBox,
  renderCodexUsageBox,
  renderCommandsBox,
  renderProgressBox,
  renderRetryBlock,
  renderStatusBox,
} from "../../terminal-blocks.mjs";
import { bold, reset } from "../render-utils.mjs";

const fallbackTheme = buildTerminalTheme();

export class LinesPanelComponent {
  constructor(key, lines = []) {
    this.key = key;
    this.lines = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);
  }

  setHost(host) {
    this.host = host;
  }

  setLines(lines = []) {
    this.lines = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);
    this.host?.invalidate();
  }

  render() {
    return this.lines;
  }
}

export function commandsPanel(theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent(`commands-${Date.now()}`, renderCommandsBox(theme, width));
}

export function statusPanel(status, theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent(`status-${Date.now()}`, renderStatusBox(status, theme, width));
}

export function accountPanel(account, theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent(`account-${Date.now()}`, renderAccountStatusBox(account, theme, width));
}

export function codexUsagePanel(stats, theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent(`usage-${Date.now()}`, renderCodexUsageBox(stats, theme, width));
}

export function progressPanel(progress, theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent("progress", renderProgressBox(progress, theme, width));
}

export function retryPanel(event, theme = fallbackTheme, width = 100) {
  return new LinesPanelComponent(`retry-${Date.now()}`, renderRetryBlock(event, theme, width));
}

export function infoPanel(text, theme = fallbackTheme) {
  return new LinesPanelComponent(`info-${Date.now()}`, ["", `${theme.success}${text}${reset}`]);
}

export function errorPanel(error, theme = fallbackTheme) {
  return new LinesPanelComponent(`error-${Date.now()}`, [
    "",
    `${theme.error}Error:${reset} ${error instanceof Error ? error.message : String(error)}`,
    "",
  ]);
}

export function memoryPanel(status, theme = fallbackTheme) {
  const lines = [""];
  const overview = status.memoryOverview ?? ["What I know about Cara", "  Nothing stable yet."];
  const commands = status.customCommands ?? [];
  for (const memoryLine of overview) {
    if (!memoryLine) {
      lines.push("");
    } else if (!memoryLine.startsWith("  ") && !memoryLine.startsWith("- ")) {
      lines.push(`${bold}${theme.primary}${memoryLine}${reset}`);
    } else {
      lines.push(`${theme.muted}${memoryLine}${reset}`);
    }
  }
  lines.push("", `${bold}Custom commands${reset}`);
  if (!commands.length) {
    lines.push(`${theme.muted}  Add markdown commands in .cara/commands/*.md.${reset}`);
  } else {
    for (const command of commands) {
      lines.push(`  ${theme.success}/${command.name}${reset} ${theme.muted}${command.description}${reset}`);
    }
  }
  return new LinesPanelComponent(`memory-${Date.now()}`, lines);
}

export function sessionInfoPanel(info = {}, theme = fallbackTheme) {
  const messages = info.messages ?? {};
  const tokens = info.tokens ?? {};
  const cost = info.cost ?? {};
  return new LinesPanelComponent(`session-${Date.now()}`, [
    "",
    `${bold}${theme.primary}Session Info${reset}`,
    "",
    ` ${theme.warning}File:${reset} ${theme.muted}${info.file ?? "in-memory"}${reset}`,
    ` ${theme.warning}ID:${reset} ${theme.muted}${info.id ?? "none"}${reset}`,
    "",
    `${bold} Messages${reset}`,
    ` User: ${formatCount(messages.user)}`,
    ` Assistant: ${formatCount(messages.assistant)}`,
    ` Tool Calls: ${formatCount(messages.toolCalls)}`,
    ` Tool Results: ${formatCount(messages.toolResults)}`,
    ` Total: ${formatCount(messages.total)}`,
    "",
    `${bold} Tokens${reset}`,
    ` Input: ${formatCount(tokens.input)}`,
    ` Output: ${formatCount(tokens.output)}`,
    ` Cache Read: ${formatCount(tokens.cacheRead)}`,
    ` Total: ${formatCount(tokens.total)}`,
    "",
    `${bold} Cost${reset}`,
    ` Total: ${Number(cost.total || 0).toFixed(4)}`,
  ]);
}

function formatCount(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}
