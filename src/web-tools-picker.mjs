import readline from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { buildTerminalTheme } from "./terminal-theme.mjs";

const reset = "\x1b[0m";
const inverse = "\x1b[7m";
const bold = "\x1b[1m";
const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";

const MODES = [
  { id: "all", label: "All", description: "web search + page fetch", value: { webSearch: true, webFetch: true } },
  { id: "none", label: "None", description: "disable web tools", value: { webSearch: false, webFetch: false } },
  { id: "websearch", label: "Web search", description: "search results only", value: { webSearch: true, webFetch: false } },
  { id: "webfetch", label: "Web fetch", description: "fetch URL pages only", value: { webSearch: false, webFetch: true } },
];

export async function selectWebTools(current = {}, options = {}) {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  if (!input.isTTY || !output.isTTY) return null;

  const theme = buildTerminalTheme(options.theme);
  readline.emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  if (!wasRaw) input.setRawMode(true);
  input.resume();

  let selected = Math.max(0, MODES.findIndex((item) => modeMatches(item.value, current)));
  if (selected < 0) selected = 0;
  let renderedLines = 0;
  let done = false;
  let resolveDone = () => {};
  const completion = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function clear() {
    if (renderedLines > 0) {
      readline.moveCursor(output, 0, -renderedLines);
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      renderedLines = 0;
    }
  }

  function render() {
    const width = Math.max(54, (output.columns ?? 90) - 1);
    const lines = [
      `${bold}${theme.primary}Web tools${reset} ${theme.muted}Space selects - Enter saves - Esc cancels${reset}`,
      `${theme.muted}${"-".repeat(Math.min(width, 78))}${reset}`,
    ];

    MODES.forEach((mode, index) => {
      const active = index === selected;
      const checked = active ? "x" : " ";
      const row = ` [${checked}] ${mode.label.padEnd(12)} ${mode.description}`;
      lines.push(active ? `${inverse}${row.padEnd(Math.min(width, 78), " ")}${reset}` : ` ${theme.primary}[ ]${reset} ${mode.label.padEnd(12)} ${theme.muted}${mode.description}${reset}`);
    });

    clear();
    output.write(`${hideCursor}${lines.join("\n")}`);
    renderedLines = lines.length - 1;
  }

  function finish(value) {
    if (done) return;
    done = true;
    input.off("keypress", onKeypress);
    if (!wasRaw) {
      input.setRawMode(false);
      input.pause();
    }
    clear();
    output.write(showCursor);
    resolveDone(value);
  }

  function onKeypress(_str, key) {
    let handled = true;
    if (key?.ctrl && key.name === "c") process.exit(130);
    if (key?.name === "escape") return finish(null);
    if (key?.name === "return") return finish(MODES[selected].value);
    if (key?.name === "space" || _str === " ") return render();
    if (key?.name === "down") selected = (selected + 1) % MODES.length;
    else if (key?.name === "up") selected = (selected - 1 + MODES.length) % MODES.length;
    else if (typeof _str === "string" && /^[1-4]$/.test(_str)) selected = Number(_str) - 1;
    else handled = false;
    if (!handled) return;
    render();
  }

  input.on("keypress", onKeypress);
  render();
  return completion;
}

export function normalizeWebToolsMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["all", "on", "enable", "enabled", "true", "1", "yes"].includes(text)) return { webSearch: true, webFetch: true };
  if (["none", "off", "disable", "disabled", "false", "0", "no"].includes(text)) return { webSearch: false, webFetch: false };
  if (["search", "websearch", "web-search"].includes(text)) return { webSearch: true, webFetch: false };
  if (["fetch", "webfetch", "web-fetch"].includes(text)) return { webSearch: false, webFetch: true };
  return undefined;
}

function modeMatches(mode, current) {
  return Boolean(mode.webSearch) === Boolean(current.webSearch)
    && Boolean(mode.webFetch) === Boolean(current.webFetch);
}
