import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { buildTerminalTheme } from "./terminal-theme.mjs";

const reset = "\x1b[0m";
const inverse = "\x1b[7m";
const bold = "\x1b[1m";
const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";

export async function selectSession(sessions, options = {}) {
  if (!sessions.length) return null;
  if (!input.isTTY || !output.isTTY) return sessions[0].path;

  const theme = buildTerminalTheme(options.theme);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let selected = 0;
  let page = 0;
  let renderedLines = 0;
  let done = false;
  let resolveDone = () => {};
  const completion = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const pageSize = () => Math.max(5, Math.min(12, (output.rows ?? 24) - 8));
  const pageCount = () => Math.max(1, Math.ceil(sessions.length / pageSize()));

  function clear() {
    if (renderedLines > 0) {
      readline.moveCursor(output, 0, -renderedLines);
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      renderedLines = 0;
    }
  }

  function render() {
    const size = pageSize();
    page = Math.max(0, Math.min(page, pageCount() - 1));
    selected = Math.max(page * size, Math.min(selected, sessions.length - 1));
    if (selected < page * size) selected = page * size;
    if (selected >= (page + 1) * size) selected = (page + 1) * size - 1;

    const width = Math.max(72, (output.columns ?? 100) - 1);
    const start = page * size;
    const rows = sessions.slice(start, start + size);
    const lines = [
      `${bold}${theme.primary}Choose a chat${reset} ${theme.muted}(${page + 1}/${pageCount()})${reset}`,
      `${theme.muted}${pad("ID", 10)} ${pad("When", 12)} ${pad("Msgs", 6)} Title${reset}`,
      `${theme.muted}${"-".repeat(Math.min(width, 92))}${reset}`,
    ];

    rows.forEach((session, offset) => {
      const index = start + offset;
      const active = index === selected;
      const title = truncate((session.name || session.firstMessage || "(no messages)").replace(/\s+/g, " "), width - 34);
      const row = `${pad(session.id.slice(0, 8), 10)} ${pad(formatTime(session.modified), 12)} ${pad(String(session.messageCount), 6)} ${title}`;
      lines.push(active ? `${inverse}${row.padEnd(Math.min(width, 92), " ")}${reset}` : ` ${theme.success}${session.id.slice(0, 8)}${reset} ${theme.muted}${pad(formatTime(session.modified), 12)} ${pad(String(session.messageCount), 6)}${reset} ${title}`);
    });

    lines.push(`${theme.muted}Enter opens - arrows move - PgUp/PgDn page - Esc cancels${reset}`);
    clear();
    output.write(`${hideCursor}${lines.join("\n")}`);
    renderedLines = lines.length - 1;
  }

  function finish(value) {
    if (done) return;
    done = true;
    input.off("keypress", onKeypress);
    input.setRawMode(false);
    input.pause();
    clear();
    output.write(showCursor);
    resolveDone(value);
  }

  function onKeypress(_str, key) {
    const size = pageSize();
    let handled = true;
    if (key?.ctrl && key.name === "c") process.exit(130);
    if (key?.name === "escape") return finish(null);
    if (key?.name === "return") return finish(sessions[selected]?.path ?? null);
    if (key?.name === "down") selected = Math.min(sessions.length - 1, selected + 1);
    else if (key?.name === "up") selected = Math.max(0, selected - 1);
    else if (key?.name === "pagedown") selected = Math.min(sessions.length - 1, selected + size);
    else if (key?.name === "pageup") selected = Math.max(0, selected - size);
    else handled = false;
    if (!handled) return;
    page = Math.floor(selected / size);
    render();
  }

  input.on("keypress", onKeypress);
  render();
  return completion;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function pad(value, length) {
  return String(value).padEnd(length, " ").slice(0, length);
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 3))}...` : value;
}
