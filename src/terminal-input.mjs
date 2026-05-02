import readline from "node:readline";
import { readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { buildTerminalTheme } from "./terminal-theme.mjs";

const normalIntensity = "\x1b[22m";
const bold = "\x1b[1m";
const fgReset = "\x1b[39m";
const inverse = "\x1b[7m";
const reset = "\x1b[0m";
const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";
const syncStart = "\x1b[?2026h";
const syncEnd = "\x1b[?2026l";
const fakeCursor = "\x1b[7m \x1b[27m";
const inputPlaceholders = loadJson("./input-placeholders.json", { placeholders: ["message..."] }).placeholders ?? ["message..."];
const pastedTextThreshold = 80;

export async function runTerminalInputLoop(onInput, options = {}, controls) {
  if (!input.isTTY || !output.isTTY) {
    await readPipe(onInput);
    return;
  }

  const theme = buildTerminalTheme(options.theme);

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let buffer = "";
  let pastedBlocks = [];
  let pastedImages = [];
  let pendingInsertedText = "";
  let pendingInsertTimer = undefined;
  let selectedIndex = 0;
  let renderedLines = 0;
  let renderedPromptIndex = 0;
  let waiting = false;
  let busyStartedAt = 0;
  let busyFrame = 0;
  let completedText = "";
  let suppressSuggestionsFor = "";
  let placeholderText = pickPlaceholder();
  let renderedMenuLines = 0;
  let renderedEditorLines = 0;
  let hasTranscript = false;
  let cleanedUp = false;
  let batchOpen = false;
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const beginBatch = () => {
    if (batchOpen) return;
    output.write(`${hideCursor}${syncStart}`);
    batchOpen = true;
  };

  const endBatch = (showHardwareCursor = false) => {
    if (!batchOpen) return;
    output.write(`${syncEnd}${showHardwareCursor ? showCursor : hideCursor}`);
    batchOpen = false;
  };

  const suggestionsFor = (text) => {
    if (completedText && text === completedText) return [];
    if (suppressSuggestionsFor && text === suppressSuggestionsFor) return [];
    return options.suggestions?.(text) ?? [];
  };

  const clear = () => {
    if (renderedLines === 0) return;
    beginBatch();
    if (renderedPromptIndex > 0) {
      readline.moveCursor(output, 0, -renderedPromptIndex);
    }
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLines = 0;
    renderedPromptIndex = 0;
    renderedMenuLines = 0;
    renderedEditorLines = 0;
  };

  const render = () => {
    const liveWidth = Math.max(24, (output.columns ?? 100) - 1);
    const turnActive = controls.getBusy() || waiting;
    const isBusy = turnActive && !controls.suppressWorking?.();
    if (turnActive && !busyStartedAt) busyStartedAt = Date.now();
    if (!turnActive) busyStartedAt = 0;
    const prompt = `${theme.primary}>${fgReset} `;
    const suggestions = suggestionsFor(buffer);
    if (selectedIndex >= suggestions.length) selectedIndex = 0;
    const maxVisible = options.maxSuggestions ?? 10;
    const startIndex = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), suggestions.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, suggestions.length);

    const transientLines = trimTrailingBlankEdges(controls.getTransientLines?.() ?? []);
    const lines = [];
    if (transientLines.length > 0) {
      lines.push(...transientLines, "");
    } else if (hasTranscript) {
      lines.push("");
    }
    const displayText = displayTextFor(buffer, pastedBlocks);
    const editorLines = renderEditorLines({ prompt, text: displayText, placeholder: placeholderText }, liveWidth, theme);
    lines.push(...editorLines);
    const menuLines = [];
    if (suggestions.length > 0) {
      for (let i = startIndex; i < endIndex; i += 1) {
        const item = suggestions[i];
        const marker = i === selectedIndex ? `${inverse}>${reset}` : `${theme.muted}-${reset}`;
        const label = i === selectedIndex ? `${inverse}${item.label}${reset}` : `${theme.primary}${item.label}${reset}`;
        menuLines.push(`${marker} ${label} ${theme.muted}${item.description ?? ""}${reset}`);
      }
      if (startIndex > 0 || endIndex < suggestions.length) {
        menuLines.push(`${theme.muted}(${selectedIndex + 1}/${suggestions.length})${reset}`);
      }
    }
    lines.push(...menuLines);
    const activityLabel = controls.getActivityLabel?.() || (waiting ? "sending" : "working");
    const statusLine = options.statusLine?.(liveWidth, {
      activity: isBusy ? renderWorkingStatus(busyStartedAt, busyFrame, theme, activityLabel) : "",
    });
    if (statusLine) {
      lines.push(`${theme.muted}${statusLine}${reset}`);
    }

    const previousRenderedLines = renderedLines;
    const menuChangedHeight = renderedMenuLines !== menuLines.length;
    const editorChangedHeight = renderedEditorLines !== editorLines.length;
    const topPadding =
      !menuChangedHeight && !editorChangedHeight && previousRenderedLines > lines.length
        ? previousRenderedLines - lines.length
        : 0;

    beginBatch();
    clear();
    if (topPadding > 0) {
      output.write("\n".repeat(topPadding));
    }
    output.write(lines.join("\n"));
    renderedLines = lines.length + topPadding;
    renderedMenuLines = menuLines.length;
    renderedEditorLines = editorLines.length;
    renderedPromptIndex = Math.max(0, renderedLines - 1);
    endBatch();
  };

  const completeSelection = (completionOptions = {}) => {
    const suggestions = suggestionsFor(buffer);
    if (suggestions.length === 0) return false;
    const selected = suggestions[selectedIndex];
    const next = options.applySuggestion?.(buffer, selected) ?? selected?.value;
    if (!next) return false;
    buffer = next;
    completedText = next.endsWith(" ") ? "" : next;
    suppressSuggestionsFor = selected.kind === "custom-model" ? next : "";
    selectedIndex = 0;
    render();
    if (completionOptions.submitOnEnter && selected.submitOnEnter) {
      return next.trim();
    }
    return false;
  };

  const flushPendingTextInput = () => {
    if (pendingInsertTimer) {
      clearTimeout(pendingInsertTimer);
      pendingInsertTimer = undefined;
    }
    if (!pendingInsertedText) return;
    const str = pendingInsertedText;
    pendingInsertedText = "";
    const start = buffer.length;
    buffer += str;
    if (isLikelyPaste(str)) {
      pastedBlocks.push({
        id: `paste-${Date.now()}-${pastedBlocks.length + 1}`,
        type: "text",
        start,
        end: buffer.length,
        label: `[Pasted Content ${str.length.toLocaleString("en-US")} chars]`,
      });
    }
    completedText = "";
    suppressSuggestionsFor = "";
    selectedIndex = 0;
    render();
  };

  const queueTextInput = (str) => {
    pendingInsertedText += str;
    if (pendingInsertTimer) clearTimeout(pendingInsertTimer);
    pendingInsertTimer = setTimeout(flushPendingTextInput, 18);
  };

  const submit = async (text) => {
    const displayText = displayTextFor(text, pastedBlocks);
    const submission =
      pastedImages.length > 0 || displayText !== text
        ? {
            text,
            displayText,
            images: pastedImages.map((item) => item.image),
          }
        : text;
    beginBatch();
    clear();
    output.write(`\n${renderUserMessage(displayText, theme)}\n`);
    endBatch();
    hasTranscript = true;
    buffer = "";
    pastedBlocks = [];
    pastedImages = [];
    placeholderText = pickPlaceholder(placeholderText);
    selectedIndex = 0;
    suppressSuggestionsFor = "";
    waiting = shouldShowWaitingFor(text);
    render();
    try {
      return await onInput(submission);
    } finally {
      waiting = false;
      render();
    }
  };

  controls.setRenderers(render, clear);
  render();
  const animation = setInterval(() => {
    if (cleanedUp) return;
    if (waiting || controls.getBusy()) {
      busyFrame += 1;
      render();
    }
  }, 420);

  const onKeypress = async (str, key) => {
    const isPlainTextInput = str && !key?.ctrl && !key?.meta && !key?.alt && (str >= " " || /\r|\n/.test(str));
    if (!isPlainTextInput) {
      flushPendingTextInput();
    }
    if (key?.ctrl && key.name === "c") {
      clear();
      cleanup();
      process.exit(130);
    }
    const suggestions = suggestionsFor(buffer);
    if (key?.name === "down" && suggestions.length > 0) {
      selectedIndex = (selectedIndex + 1) % suggestions.length;
      render();
      return;
    }
    if (key?.name === "up" && suggestions.length > 0) {
      selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
      render();
      return;
    }
    if ((key?.name === "tab" || key?.name === "right") && suggestions.length > 0) {
      completeSelection();
      return;
    }
    if (key?.name === "return") {
      if (suggestions.length > 0) {
        const completed = completeSelection({ submitOnEnter: true });
        if (typeof completed === "string" && completed.length > 0) {
          const shouldExit = await submit(completed);
          if (shouldExit) cleanup();
        }
        return;
      }
      const text = buffer.trim();
      if (!text) {
        render();
        return;
      }
      const shouldExit = await submit(text);
      if (shouldExit) cleanup();
      return;
    }
    if (key?.name === "backspace") {
      const removed = removeLastInputUnit(buffer, pastedBlocks, pastedImages);
      buffer = removed.buffer;
      pastedBlocks = removed.blocks;
      pastedImages = removed.images;
      completedText = "";
      suppressSuggestionsFor = "";
      selectedIndex = 0;
      render();
      return;
    }
    if (key?.name === "escape") {
      buffer = "";
      pastedBlocks = [];
      pastedImages = [];
      completedText = "";
      suppressSuggestionsFor = "";
      selectedIndex = 0;
      render();
      return;
    }
    if ((key?.meta || key?.alt) && key?.name === "v") {
      const pastedImage = readClipboardImage();
      if (pastedImage) {
        const id = `image-${Date.now()}-${pastedImages.length + 1}`;
        const dimensions =
          pastedImage.width && pastedImage.height ? ` ${pastedImage.width}x${pastedImage.height}` : "";
        const label = `[Pasted Image${dimensions}]`;
        const prefix = buffer && !/\s$/.test(buffer) ? " " : "";
        const start = buffer.length + prefix.length;
        buffer += `${prefix}${label}`;
        pastedBlocks.push({ id, type: "image", start, end: buffer.length, label });
        pastedImages.push({ id, image: pastedImage.image });
        completedText = "";
        suppressSuggestionsFor = "";
        selectedIndex = 0;
        render();
      }
      return;
    }
    if (isPlainTextInput) {
      queueTextInput(str);
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    input.off("keypress", onKeypress);
    if (pendingInsertTimer) clearTimeout(pendingInsertTimer);
    clearInterval(animation);
    input.setRawMode(false);
    input.pause();
    controls.clearRenderers();
    endBatch(true);
    output.write(`${showCursor}\n`);
    finish();
  };

  input.on("keypress", onKeypress);
  await done;
}

function shouldShowWaitingFor(text) {
  const value = String(text ?? "").trim().toLowerCase();
  return Boolean(value && !value.startsWith("/") && value !== "exit" && value !== "quit");
}

function isLikelyPaste(value) {
  return value.length >= pastedTextThreshold || /\r|\n/.test(value);
}

function displayTextFor(text, blocks = []) {
  const validBlocks = blocks
    .filter((block) => Number.isInteger(block.start) && Number.isInteger(block.end) && block.end <= text.length)
    .sort((a, b) => a.start - b.start);
  if (validBlocks.length === 0) return text;

  let cursor = 0;
  let rendered = "";
  for (const block of validBlocks) {
    if (block.start < cursor) continue;
    rendered += text.slice(cursor, block.start);
    rendered += block.label;
    cursor = block.end;
  }
  rendered += text.slice(cursor);
  return rendered;
}

function removeLastInputUnit(buffer, blocks, images) {
  if (!buffer) return { buffer, blocks, images };
  const lastBlock = [...blocks]
    .filter((block) => block.end === buffer.length)
    .sort((a, b) => b.start - a.start)[0];
  if (!lastBlock) {
    return {
      buffer: buffer.slice(0, -1),
      blocks: blocks.filter((block) => block.end <= buffer.length - 1),
      images,
    };
  }

  return {
    buffer: buffer.slice(0, lastBlock.start),
    blocks: blocks.filter((block) => block.id !== lastBlock.id && block.end <= lastBlock.start),
    images: lastBlock.type === "image" ? images.filter((item) => item.id !== lastBlock.id) : images,
  };
}

function readClipboardImage() {
  if (process.platform !== "win32") return null;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }
$img = [System.Windows.Forms.Clipboard]::GetImage()
$stream = New-Object System.IO.MemoryStream
$img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$payload = [pscustomobject]@{
  data = [Convert]::ToBase64String($stream.ToArray())
  mimeType = 'image/png'
  width = $img.Width
  height = $img.Height
}
$payload | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const payload = JSON.parse(result.stdout.trim());
    if (!payload?.data || !payload?.mimeType) return null;
    return {
      width: payload.width,
      height: payload.height,
      image: {
        type: "image",
        data: payload.data,
        mimeType: payload.mimeType,
      },
    };
  } catch {
    return null;
  }
}

function trimTrailingBlankEdges(lines) {
  let end = lines.length;
  while (end > 0 && isBlankLine(lines[end - 1])) end -= 1;
  return lines.slice(0, end);
}

function isBlankLine(line) {
  return stripAnsi(line).trim().length === 0;
}

function renderWorkingStatus(startedAt, frame, theme = buildTerminalTheme(), label = "working") {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const dots = ".".repeat((frame % 3) + 1);
  return `${bold}${shimmerText(`${elapsed}s ${cleanActivityLabel(label)}${dots}`, frame, theme)}${reset}${theme.muted}`;
}

function cleanActivityLabel(value) {
  return String(value ?? "working").replace(/\s+/g, " ").trim() || "working";
}

function shimmerText(text, frame, theme = buildTerminalTheme()) {
  const chars = Array.from(text);
  const shimmerIndex = frame % Math.max(1, chars.length);
  return chars
    .map((char, index) => {
      const distance = Math.abs(index - shimmerIndex);
      const color = distance === 0 ? theme.warning : distance === 1 ? theme.accent : theme.primary;
      return `${color}${char}`;
    })
    .join("");
}

function renderEditorLines({ prompt, text = "", placeholder = "message..." }, width = Math.max(24, (output.columns ?? 100) - 1), theme = buildTerminalTheme()) {
  const promptWidth = visibleWidth(prompt);
  const rowWidth = Math.max(1, width - promptWidth);

  if (!text) {
    const placeholderLine = `${prompt}${fakeCursor}${theme.muted}${placeholder}${reset}`;
    return [renderEditorRule(width, theme), padToVisibleWidth(placeholderLine, width), renderEditorRule(width, theme)];
  }

  const rows = wrapEditorInput(text, rowWidth);
  return [
    renderEditorRule(width, theme),
    ...rows.map((row, index) => {
      const prefix = index === 0 ? prompt : " ".repeat(promptWidth);
      return padToVisibleWidth(`${prefix}${row}`, width);
    }),
    renderEditorRule(width, theme),
  ];
}

function renderEditorRule(width, theme = buildTerminalTheme()) {
  return `${theme.editorBorder}${"-".repeat(width)}${reset}`;
}

function visibleWidth(text) {
  return stripAnsi(text).length;
}

function padToVisibleWidth(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function wrapEditorInput(text, width) {
  const rows = [];
  let row = "";
  const cells = [...Array.from(text), fakeCursor];

  for (const cell of cells) {
    if (visibleWidth(row) >= width) {
      rows.push(row);
      row = "";
    }
    row += cell;
  }

  if (row || rows.length === 0) rows.push(row);
  return rows;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderUserMessage(text, theme = buildTerminalTheme()) {
  const width = Math.max(24, (output.columns ?? 100) - 1);
  const contentWidth = Math.max(1, width);
  const rows = wrapPlain(`> ${text}`, contentWidth);
  const bgLine = (content = "") => `${theme.userBg}${theme.userFg}${content.padEnd(contentWidth, " ")}${reset}`;
  return [bgLine(), ...rows.map((row) => bgLine(row)), bgLine()].join("\n");
}

function wrapPlain(text, width) {
  if (text.length <= width) return [text];
  const rows = [];
  let rest = text;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt < Math.floor(width * 0.45)) breakAt = width;
    rows.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) rows.push(rest);
  return rows;
}

async function readPipe(onInput) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const shouldExit = await onInput(trimmed);
    if (shouldExit) break;
  }
}

function pickPlaceholder(previous = "") {
  const values = inputPlaceholders.filter((value) => typeof value === "string" && value.trim());
  if (values.length === 0) return "message...";
  if (values.length === 1) return values[0];
  let next = values[Math.floor(Math.random() * values.length)];
  if (next === previous) {
    next = values[(values.indexOf(next) + 1) % values.length];
  }
  return next;
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  } catch {
    return fallback;
  }
}
