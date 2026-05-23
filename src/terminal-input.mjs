import readline from "node:readline";
import { readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
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
const busyAnimationMs = 120;

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
  let resizeRenderTimer = undefined;
  let selectedIndex = 0;
  let renderedLines = 0;
  let renderedPromptIndex = 0;
  let renderedPhysicalRows = 0;
  let renderedPromptPhysicalIndex = 0;
  let waiting = false;
  let busyStartedAt = 0;
  let busyFrame = 0;
  let completedText = "";
  let suppressSuggestionsFor = "";
  let placeholderText = pickPlaceholder();
  let renderedMenuLines = 0;
  let renderedEditorLines = 0;
  let lastRenderedOutput = "";
  let lastRenderedLines = [];
  let lastSelectedSuggestionKey = "";
  let hasTranscript = false;
  let inputHistory = [];
  let inputHistoryIndex = null;
  let inputHistoryDraft = "";
  const starterRecommendations = normalizeStarterRecommendations(options.starterRecommendations);
  let starterRecommendationDismissed = false;
  let insertedStarterPrompt = "";
  const imagePastePromises = new Set();
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
    if (renderedLines === 0 && renderedPhysicalRows === 0) return;
    beginBatch();
    const clearWidth = terminalRenderWidth();
    const rowsAtCurrentWidth = countPhysicalRows(lastRenderedLines, clearWidth);
    const rowsToMove = Math.max(renderedPromptPhysicalIndex, Math.max(0, rowsAtCurrentWidth - 1));
    if (rowsToMove > 0) {
      readline.moveCursor(output, 0, -rowsToMove);
    }
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLines = 0;
    renderedPromptIndex = 0;
    renderedPhysicalRows = 0;
    renderedPromptPhysicalIndex = 0;
    renderedMenuLines = 0;
    renderedEditorLines = 0;
    lastRenderedOutput = "";
    lastRenderedLines = [];
  };

  const render = () => {
    const liveWidth = terminalRenderWidth();
    const turnActive = controls.getBusy() || waiting;
    const isBusy = turnActive && !controls.suppressWorking?.();
    if (turnActive && !busyStartedAt) busyStartedAt = Date.now();
    if (!turnActive) busyStartedAt = 0;
    const activityLabel = controls.getActivityLabel?.() || (waiting ? "starting" : "working");
    const prompt = `${theme.primary}>${fgReset} `;
    const suggestions = suggestionsFor(buffer);
    if (selectedIndex >= suggestions.length) selectedIndex = 0;
    notifySelectedSuggestion(suggestions[selectedIndex]);
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
    const showStarterRecommendations = shouldShowStarterRecommendations();
    if (showStarterRecommendations) {
      lines.push(renderStarterRecommendationLine(starterRecommendations[0], liveWidth, theme));
    }
    if (isBusy) {
      lines.push(renderInputActivityLine(busyFrame, theme, activityLabel));
    }
    const displayText = displayTextFor(buffer, pastedBlocks);
    const editorLines = renderEditorLines({ prompt, text: displayText, placeholder: placeholderText }, liveWidth, theme)
      .map((line) => styleAttachmentLabels(line, theme, fgReset));
    lines.push(...editorLines);
    const menuLines = [];
    if (suggestions.length > 0) {
      for (let i = startIndex; i < endIndex; i += 1) {
        const item = suggestions[i];
        const marker = i === selectedIndex ? `${inverse}>${reset}` : `${theme.muted}-${reset}`;
        const label = i === selectedIndex ? `${inverse}${item.label}${reset}` : `${theme.primary}${item.label}${reset}`;
        const left = `${marker} ${label} ${theme.muted}${item.description ?? ""}${reset}`;
        menuLines.push(alignMenuPreview(left, item.preview, liveWidth, theme));
      }
      if (startIndex > 0 || endIndex < suggestions.length) {
        menuLines.push(`${theme.muted}(${selectedIndex + 1}/${suggestions.length})${reset}`);
      }
    }
    lines.push(...menuLines);
    const statusLine = options.statusLine?.(liveWidth, {
      activity: "",
    });
    if (statusLine) {
      lines.push(statusLine);
    }

    const nextOutput = lines.join("\n");
    if (nextOutput === lastRenderedOutput) return;

    beginBatch();
    clear();
    output.write(nextOutput);
    renderedLines = lines.length;
    lastRenderedOutput = nextOutput;
    lastRenderedLines = [...lines];
    renderedMenuLines = menuLines.length;
    renderedEditorLines = editorLines.length;
    renderedPromptIndex = Math.max(0, renderedLines - 1);
    renderedPhysicalRows = countPhysicalRows(lines, liveWidth);
    renderedPromptPhysicalIndex = Math.max(0, renderedPhysicalRows - 1);
    endBatch();
  };

  const scheduleResizeRender = () => {
    if (cleanedUp) return;
    if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
    resizeRenderTimer = setTimeout(() => {
      resizeRenderTimer = undefined;
      lastRenderedOutput = "";
      render();
    }, 24);
  };

  const notifySelectedSuggestion = (item) => {
    const key = item ? `${item.kind ?? ""}:${item.value ?? item.label ?? ""}` : "";
    if (key === lastSelectedSuggestionKey) return;
    lastSelectedSuggestionKey = key;
    queueMicrotask(() => options.onSuggestionSelect?.(item));
  };

  const completeSelection = (completionOptions = {}) => {
    const suggestions = suggestionsFor(buffer);
    if (suggestions.length === 0) return false;
    const selected = suggestions[selectedIndex];
    const next = options.applySuggestion?.(buffer, selected) ?? selected?.value;
    if (!next) return false;
    buffer = next;
    completedText = next.endsWith(" ") || (selected.kind === "file-mention" && selected.isDirectory) ? "" : next;
    suppressSuggestionsFor = selected.kind === "custom-model" ? next : "";
    selectedIndex = 0;
    inputHistoryIndex = null;
    render();
    if (completionOptions.submitOnEnter && selected.submitOnEnter) {
      return next.trim();
    }
    return false;
  };

  const shouldShowStarterRecommendations = () => {
    return !starterRecommendationDismissed && !hasTranscript && !waiting && !buffer.trim() && starterRecommendations.length > 0;
  };

  const insertStarterRecommendation = () => {
    const selected = starterRecommendations[0];
    if (!selected?.prompt) return false;
    buffer = selected.prompt;
    insertedStarterPrompt = selected.prompt;
    completedText = "";
    suppressSuggestionsFor = "";
    selectedIndex = 0;
    inputHistoryIndex = null;
    render();
    return true;
  };

  const clearStarterRecommendation = () => {
    if (insertedStarterPrompt && buffer.trim() === insertedStarterPrompt.trim()) {
      buffer = "";
    }
    starterRecommendationDismissed = true;
    insertedStarterPrompt = "";
    completedText = "";
    suppressSuggestionsFor = "";
    selectedIndex = 0;
    inputHistoryIndex = null;
    render();
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
    insertedStarterPrompt = "";
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
    inputHistoryIndex = null;
    render();
  };

  const queueTextInput = (str) => {
    pendingInsertedText += str;
    if (pendingInsertTimer) clearTimeout(pendingInsertTimer);
    pendingInsertTimer = setTimeout(flushPendingTextInput, 18);
  };

  const submit = async (text) => {
    let submittedText = text;
    if (imagePastePromises.size > 0) {
      waiting = true;
      render();
      await Promise.allSettled([...imagePastePromises]);
      submittedText = buffer.trim();
    }
    const displayText = displayTextFor(submittedText, pastedBlocks);
    const hasImages = pastedImages.length > 0;
    if (!submittedText && !hasImages) {
      waiting = false;
      render();
      return false;
    }
    const submission =
      hasImages || displayText !== submittedText
        ? {
            text: submittedText,
            displayText,
            images: pastedImages.map((item) => item.image),
          }
        : submittedText;
    beginBatch();
    clear();
    output.write(`\n${renderUserMessage(displayText, theme)}\n`);
    endBatch();
    rememberInputHistory(submittedText);
    hasTranscript = true;
    buffer = "";
    pastedBlocks = [];
    pastedImages = [];
    placeholderText = pickPlaceholder(placeholderText);
    selectedIndex = 0;
    suppressSuggestionsFor = "";
    inputHistoryIndex = null;
    waiting = hasImages || shouldShowWaitingFor(submittedText);
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
  }, busyAnimationMs);

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
    const starterPromptIsInserted = insertedStarterPrompt && buffer.trim() === insertedStarterPrompt.trim();
    if (key?.name === "down" && (shouldShowStarterRecommendations() || starterPromptIsInserted)) {
      clearStarterRecommendation();
      return;
    }
    if (key?.name === "up" && shouldShowStarterRecommendations()) {
      insertStarterRecommendation();
      return;
    }
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
    if (key?.name === "up" && recallInputHistory(-1)) {
      render();
      return;
    }
    if (key?.name === "down" && recallInputHistory(1)) {
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
      if (!text && imagePastePromises.size === 0) {
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
      insertedStarterPrompt = "";
      pastedBlocks = removed.blocks;
      pastedImages = removed.images;
      completedText = "";
      suppressSuggestionsFor = "";
      selectedIndex = 0;
      inputHistoryIndex = null;
      render();
      return;
    }
    if (key?.name === "escape") {
      buffer = "";
      insertedStarterPrompt = "";
      pastedBlocks = [];
      pastedImages = [];
      completedText = "";
      suppressSuggestionsFor = "";
      selectedIndex = 0;
      inputHistoryIndex = null;
      render();
      return;
    }
    if ((key?.meta || key?.alt) && key?.name === "v") {
      const id = `image-${Date.now()}-${pastedImages.length + 1}`;
      let blockIdInserted = false;

      const insertPastedImageBlock = (pastedImage) => {
        if (cleanedUp || blockIdInserted || !pastedImage) return;
        const prefix = buffer && !/\s$/.test(buffer) ? " " : "";
        const dimensions =
          pastedImage.width && pastedImage.height ? ` ${pastedImage.width}x${pastedImage.height}` : "";
        const start = buffer.length;
        const label = `${prefix}[Pasted Image${dimensions}]`;
        buffer += label;
        pastedBlocks.push({ id, type: "image", start, end: buffer.length, label });
        pastedImages = [...pastedImages.filter((item) => item.id !== id), { id, image: pastedImage.image }];
        blockIdInserted = true;
        completedText = "";
        suppressSuggestionsFor = "";
        selectedIndex = 0;
        inputHistoryIndex = null;
        render();
      };

      const pastePromise = (async () => {
        const pastedImage = await readClipboardImage();
        if (cleanedUp) return;
        insertPastedImageBlock(pastedImage);
      })();
      imagePastePromises.add(pastePromise);
      pastePromise.finally(() => imagePastePromises.delete(pastePromise)).catch(() => {});
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
    if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
    output.off?.("resize", scheduleResizeRender);
    process.off?.("SIGWINCH", scheduleResizeRender);
    clearInterval(animation);
    input.setRawMode(false);
    input.pause();
    controls.clearRenderers();
    endBatch(true);
    output.write(`${showCursor}\n`);
    finish();
  };

  output.on?.("resize", scheduleResizeRender);
  process.on?.("SIGWINCH", scheduleResizeRender);
  input.on("keypress", onKeypress);
  await done;

  function rememberInputHistory(text) {
    const value = String(text ?? "").trim();
    if (!value) return;
    inputHistory = inputHistory.filter((item) => item !== value);
    inputHistory.push(value);
    if (inputHistory.length > 100) {
      inputHistory = inputHistory.slice(-100);
    }
  }

  function recallInputHistory(direction) {
    if (pastedBlocks.length > 0 || pastedImages.length > 0 || imagePastePromises.size > 0 || inputHistory.length === 0) {
      return false;
    }
    if (inputHistoryIndex === null) {
      if (direction > 0 || buffer.trim()) return false;
      inputHistoryDraft = buffer;
      inputHistoryIndex = inputHistory.length - 1;
    } else {
      inputHistoryIndex += direction;
    }

    if (inputHistoryIndex < 0) {
      inputHistoryIndex = 0;
    }
    if (inputHistoryIndex >= inputHistory.length) {
      inputHistoryIndex = null;
      buffer = inputHistoryDraft;
      inputHistoryDraft = "";
    } else {
      buffer = inputHistory[inputHistoryIndex];
    }

    insertedStarterPrompt = "";
    completedText = "";
    suppressSuggestionsFor = "";
    selectedIndex = 0;
    return true;
  }
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

function removeInputBlock(buffer, blocks, id) {
  const block = blocks.find((item) => item.id === id);
  if (!block) return { buffer, blocks };
  const nextBuffer = `${buffer.slice(0, block.start)}${buffer.slice(block.end)}`;
  const delta = block.start - block.end;
  return {
    buffer: nextBuffer,
    blocks: blocks
      .filter((item) => item.id !== id)
      .map((item) => item.start > block.start ? { ...item, start: item.start + delta, end: item.end + delta } : item),
  };
}

function readClipboardImage() {
  if (process.platform !== "win32") return Promise.resolve(null);
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
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      done(null);
    }, 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (status) => {
      if (status !== 0 || !stdout.trim()) {
        done(null);
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        if (!payload?.data || !payload?.mimeType) {
          done(null);
          return;
        }
        done({
          width: payload.width,
          height: payload.height,
          image: {
            type: "image",
            data: payload.data,
            mimeType: payload.mimeType,
          },
        });
      } catch {
        done(null);
      }
    });
  });
}

function trimTrailingBlankEdges(lines) {
  let end = lines.length;
  while (end > 0 && isBlankLine(lines[end - 1])) end -= 1;
  return lines.slice(0, end);
}

function isBlankLine(line) {
  return stripAnsi(line).trim().length === 0;
}

function renderInputActivityLine(frame = 0, theme = buildTerminalTheme(), label = "working") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = frames[frame % frames.length];
  return `  ${theme.accent}${spinner}${reset} ${theme.muted}${cleanActivityLabel(label)}${reset}`;
}

function cleanActivityLabel(value) {
  return String(value ?? "working").replace(/\s+/g, " ").trim() || "working";
}

function renderWorkingStatus(startedAt, frame, theme = buildTerminalTheme(), label = "working") {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const dots = ".".repeat((frame % 3) + 1);
  return `${bold}${shimmerText(`${elapsed}s ${cleanActivityLabel(label)}${dots}`, frame, theme)}${reset}${theme.muted}`;
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

function alignMenuPreview(left, preview, width, theme = buildTerminalTheme()) {
  if (!preview) return left;
  const hint = `${theme.muted}${preview}${reset}`;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(hint));
  return `${left}${" ".repeat(gap)}${hint}`;
}

function renderStarterRecommendationLine(item, width, theme = buildTerminalTheme()) {
  const prompt = String(item?.prompt ?? "").trim();
  if (!prompt) return "";
  const prefixText = width >= 42 ? "maybe start with " : "try ";
  const hintText = width >= 52 ? " - up uses it, down clears it" : width >= 34 ? " - up use, down clear" : "";
  const prefix = `${theme.muted}${prefixText}${reset}`;
  const hint = hintText ? `${theme.muted}${hintText}${reset}` : "";
  const available = Math.max(4, width - visibleWidth(prefix) - visibleWidth(hint));
  const promptText = truncatePlain(prompt, available);
  return `${prefix}${theme.primary}${promptText}${reset}${hint}`;
}

function renderEditorLines({ prompt, text = "", placeholder = "message..." }, width = terminalRenderWidth(), theme = buildTerminalTheme()) {
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

function terminalRenderWidth() {
  return Math.max(24, (output.columns ?? 100) - 3);
}

function physicalRowsForLine(line, width) {
  const liveWidth = Math.max(1, Number(width) || 1);
  return Math.max(1, Math.ceil(visibleWidth(line) / liveWidth));
}

function countPhysicalRows(lines, width) {
  return (Array.isArray(lines) ? lines : []).reduce((total, line) => total + physicalRowsForLine(line, width), 0);
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
  const width = terminalRenderWidth();
  const contentWidth = Math.max(1, width);
  const rows = wrapPlain(`> ${text}`, contentWidth);
  const bgLine = (content = "") => {
    const styled = styleAttachmentLabels(content, theme, theme.userFg ?? fgReset);
    return `${theme.userBg}${theme.userFg}${padToVisibleWidth(styled, contentWidth)}${reset}`;
  };
  return [bgLine(), ...rows.map((row) => bgLine(row)), bgLine()].join("\n");
}

function styleAttachmentLabels(text, theme = buildTerminalTheme(), restore = fgReset) {
  return String(text).replace(/\[(Pasted Image[^\]]*|Pasted Content[^\]]*)\]/g, (_match, inner) => {
    return `${theme.muted}[${theme.accent}${bold}${inner}${normalIntensity}${theme.muted}]${restore}`;
  });
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

function truncatePlain(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  if (max <= 3) return ".".repeat(Math.max(1, max));
  return `${value.slice(0, max - 3)}...`;
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

function normalizeStarterRecommendations(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") return { prompt: item.trim(), description: "" };
      return {
        prompt: String(item?.prompt ?? item?.value ?? "").trim(),
        description: String(item?.description ?? item?.why ?? "").trim(),
      };
    })
    .filter((item) => item.prompt)
    .slice(0, 1);
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  } catch {
    return fallback;
  }
}
