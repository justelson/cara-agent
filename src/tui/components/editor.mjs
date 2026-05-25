import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildTerminalTheme } from "../../terminal-theme.mjs";
import {
  bold,
  fgReset,
  inverse,
  normalIntensity,
  padToVisibleWidth,
  reset,
  truncatePlain,
  visibleWidth,
  wrapPlain,
} from "../render-utils.mjs";

const fallbackTheme = buildTerminalTheme();
const inputPlaceholders = loadJson("../../input-placeholders.json", { placeholders: ["message..."] }).placeholders ?? ["message..."];
const pastedTextThreshold = 80;

export class EditorComponent {
  constructor(options = {}) {
    this.key = "editor";
    this.theme = buildTerminalTheme(options.theme);
    this.options = options;
    this.buffer = "";
    this.pastedBlocks = [];
    this.pastedImages = [];
    this.pendingInsertedText = "";
    this.pendingInsertTimer = undefined;
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.cachedSuggestionText = undefined;
    this.cachedSuggestions = [];
    this.placeholderText = pickPlaceholder();
    this.inputHistory = [];
    this.inputHistoryIndex = null;
    this.inputHistoryDraft = "";
    this.hasTranscript = false;
    this.waiting = false;
    this.busyFrame = 0;
    this.starterRecommendations = normalizeStarterRecommendations(options.starterRecommendations);
    this.starterRecommendationDismissed = false;
    this.insertedStarterPrompt = "";
    this.imagePastePromises = new Set();
    this.onSubmit = options.onSubmit ?? (async () => false);
    this.onExit = options.onExit ?? (() => {});
  }

  setHost(host) {
    this.host = host;
  }

  setTheme(theme) {
    this.theme = buildTerminalTheme(theme);
    this.invalidateInput();
  }

  setWaiting(value) {
    this.waiting = Boolean(value);
    this.invalidateInput();
  }

  resetSession() {
    if (this.pendingInsertTimer) {
      clearTimeout(this.pendingInsertTimer);
      this.pendingInsertTimer = undefined;
    }
    this.buffer = "";
    this.pastedBlocks = [];
    this.pastedImages = [];
    this.pendingInsertedText = "";
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.inputHistoryIndex = null;
    this.inputHistoryDraft = "";
    this.hasTranscript = false;
    this.waiting = false;
    this.busyFrame = 0;
    this.starterRecommendationDismissed = false;
    this.insertedStarterPrompt = "";
    this.imagePastePromises.clear();
    this.invalidateInput({ force: true });
  }

  tickBusy() {
    this.busyFrame += 1;
    this.invalidateInput();
  }

  suggestionsFor(text) {
    if (this.completedText && text === this.completedText) return [];
    if (this.suppressSuggestionsFor && text === this.suppressSuggestionsFor) return [];
    if (text === this.cachedSuggestionText) return this.cachedSuggestions;
    const suggestions = this.options.suggestions?.(text) ?? [];
    this.cachedSuggestionText = text;
    this.cachedSuggestions = suggestions;
    return suggestions;
  }

  render(width) {
    const lines = [];
    const turnActive = Boolean(this.options.getBusy?.() || this.waiting);
    const isBusy = turnActive && !this.options.suppressWorking?.();
    const activityLabel = this.options.getActivityLabel?.() || (this.waiting ? "starting" : "working");
    const showStarterRecommendations = this.shouldShowStarterRecommendations();
    if (this.hasTranscript && !isBusy) lines.push("");
    if (showStarterRecommendations) lines.push(renderStarterRecommendationLine(this.starterRecommendations[0], width, this.theme));
    if (isBusy) {
      if (this.hasTranscript) lines.push("");
      lines.push(renderInputActivityLine(this.busyFrame, this.theme, activityLabel));
      lines.push("");
    }

    const prompt = `${this.theme.primary}>${fgReset} `;
    const displayText = displayTextFor(this.buffer, this.pastedBlocks);
    const editor = renderEditorLines({ prompt, text: displayText, placeholder: this.placeholderText }, width, this.theme);
    this.cursor = {
      row: lines.length + 1 + editor.cursor.row,
      col: editor.cursor.col,
    };
    const editorLines = editor.lines.map((line) => styleAttachmentLabels(line, this.theme, fgReset));
    const rail = renderInputRail(width, this.theme);
    lines.push(rail);
    lines.push(...editorLines);
    lines.push(rail);

    const suggestions = this.suggestionsFor(this.buffer);
    if (this.selectedIndex >= suggestions.length) this.selectedIndex = 0;
    this.alignSelectedSuggestion(suggestions);
    this.notifySelectedSuggestion(suggestions[this.selectedIndex]);
    const maxVisible = this.options.maxSuggestions ?? 10;
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), suggestions.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, suggestions.length);
    for (let i = startIndex; i < endIndex; i += 1) {
      const item = suggestions[i];
      const marker = i === this.selectedIndex ? `${inverse}>${reset}` : `${this.theme.muted}-${reset}`;
      const label = i === this.selectedIndex ? `${inverse}${item.label}${reset}` : `${this.theme.primary}${item.label}${reset}`;
      const left = `${marker} ${label} ${this.theme.muted}${item.description ?? ""}${reset}`;
      lines.push(alignMenuPreview(left, item.preview, width, this.theme));
    }
    if (startIndex > 0 || endIndex < suggestions.length) {
      lines.push(`${this.theme.muted}(${this.selectedIndex + 1}/${suggestions.length})${reset}`);
    }

    const statusLine = this.options.statusLine?.(width, { activity: "" });
    if (statusLine) lines.push("", statusLine);
    return lines;
  }

  cursorPosition(width) {
    if (!this.cursor) this.render(width);
    return this.cursor ?? null;
  }

  async handleKeypress(str, key) {
    const isPlainTextInput = str && !key?.ctrl && !key?.meta && !key?.alt && (str >= " " || /\r|\n/.test(str));
    if (!isPlainTextInput) this.flushPendingTextInput();
    if (key?.ctrl && key.name === "c") {
      this.onExit(130);
      return;
    }
    const suggestions = this.suggestionsFor(this.buffer);
    if (this.handleScrollKey(key, suggestions)) return;
    const starterPromptIsInserted = this.insertedStarterPrompt && this.buffer.trim() === this.insertedStarterPrompt.trim();
    if (key?.name === "down" && (this.shouldShowStarterRecommendations() || starterPromptIsInserted)) return this.clearStarterRecommendation();
    if (key?.name === "up" && this.shouldShowStarterRecommendations()) return this.insertStarterRecommendation();
    if (key?.name === "down" && suggestions.length > 0) {
      this.selectedIndex = (this.selectedIndex + 1) % suggestions.length;
      this.selectionDirty = true;
      this.invalidateInput();
      return;
    }
    if (key?.name === "up" && suggestions.length > 0) {
      this.selectedIndex = (this.selectedIndex - 1 + suggestions.length) % suggestions.length;
      this.selectionDirty = true;
      this.invalidateInput();
      return;
    }
    if (key?.name === "up" && this.recallInputHistory(-1)) return this.invalidateInput();
    if (key?.name === "down" && this.recallInputHistory(1)) return this.invalidateInput();
    if ((key?.name === "tab" || key?.name === "right") && suggestions.length > 0) {
      this.completeSelection();
      return;
    }
    if (key?.name === "return") {
      if (suggestions.length > 0) {
        const completed = this.completeSelection({ submitOnEnter: true });
        if (typeof completed === "string" && completed.length > 0) {
          const shouldExit = await this.submit(completed);
          if (shouldExit) this.onExit(0);
        }
        return;
      }
      const text = this.buffer.trim();
      if (!text && this.imagePastePromises.size === 0) {
        this.invalidateInput();
        return;
      }
      const shouldExit = await this.submit(text);
      if (shouldExit) this.onExit(0);
      return;
    }
    if (key?.name === "backspace") {
      const removed = removeLastInputUnit(this.buffer, this.pastedBlocks, this.pastedImages);
      this.buffer = removed.buffer;
      this.insertedStarterPrompt = "";
      this.pastedBlocks = removed.blocks;
      this.pastedImages = removed.images;
      this.completedText = "";
      this.suppressSuggestionsFor = "";
      this.selectedIndex = 0;
      this.selectionDirty = false;
      this.inputHistoryIndex = null;
      this.clearSuggestionCache();
      this.invalidateInput();
      return;
    }
    if (key?.name === "escape") {
      this.buffer = "";
      this.insertedStarterPrompt = "";
      this.pastedBlocks = [];
      this.pastedImages = [];
      this.completedText = "";
      this.suppressSuggestionsFor = "";
      this.selectedIndex = 0;
      this.selectionDirty = false;
      this.inputHistoryIndex = null;
      this.clearSuggestionCache();
      this.invalidateInput();
      return;
    }
    if ((key?.meta || key?.alt) && key?.name === "v") {
      this.queueImagePaste();
      return;
    }
    if (isPlainTextInput) this.queueTextInput(str);
  }

  handleScrollKey(key, suggestions = []) {
    if (!key?.name || !this.host?.canScroll?.()) return false;
    const canUseArrowForScroll = !this.buffer.trim() && suggestions.length === 0 && this.pastedBlocks.length === 0 && this.pastedImages.length === 0 && this.imagePastePromises.size === 0;
    const page = Math.max(4, Math.floor((this.host.height?.() ?? 24) / 2));

    if (key.name === "pageup" || key.name === "prior") return this.host.scrollBy(page);
    if (key.name === "pagedown" || key.name === "next") return this.host.scrollBy(-page);
    if (key.name === "home" && (key.ctrl || canUseArrowForScroll)) return this.host.scrollToTop();
    if (key.name === "end" && (key.ctrl || canUseArrowForScroll)) return this.host.scrollToBottom();
    if (key.name === "up" && canUseArrowForScroll) return this.host.scrollBy(3);
    if (key.name === "down" && canUseArrowForScroll) return this.host.scrollBy(-3);

    return false;
  }

  async submit(text) {
    let submittedText = text;
    if (this.imagePastePromises.size > 0) {
      this.waiting = true;
      this.invalidateInput();
      await Promise.allSettled([...this.imagePastePromises]);
      submittedText = this.buffer.trim();
    }
    const displayText = displayTextFor(submittedText, this.pastedBlocks);
    const hasImages = this.pastedImages.length > 0;
    if (!submittedText && !hasImages) {
      this.waiting = false;
      this.invalidateInput();
      return false;
    }
    const submission = hasImages || displayText !== submittedText
      ? { text: submittedText, displayText, images: this.pastedImages.map((item) => item.image) }
      : submittedText;
    this.options.onUserMessage?.(displayText);
    this.rememberInputHistory(submittedText);
    this.hasTranscript = true;
    this.buffer = "";
    this.pastedBlocks = [];
    this.pastedImages = [];
    this.placeholderText = pickPlaceholder(this.placeholderText);
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.inputHistoryIndex = null;
    this.waiting = hasImages || shouldShowWaitingFor(submittedText);
    this.invalidateInput({ force: true });
    try {
      return await this.onSubmit(submission);
    } finally {
      this.waiting = false;
      this.invalidateInput();
    }
  }

  completeSelection(completionOptions = {}) {
    const suggestions = this.suggestionsFor(this.buffer);
    if (suggestions.length === 0) return false;
    const selected = suggestions[this.selectedIndex];
    const next = this.options.applySuggestion?.(this.buffer, selected) ?? selected?.value;
    if (!next) return false;
    this.buffer = next;
    this.completedText = next.endsWith(" ") || (selected.kind === "file-mention" && selected.isDirectory) ? "" : next;
    this.suppressSuggestionsFor = selected.kind === "custom-model" ? next : "";
    this.clearSuggestionCache();
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.inputHistoryIndex = null;
    this.invalidateInput();
    if (completionOptions.submitOnEnter && selected.submitOnEnter) return next.trim();
    return false;
  }

  shouldShowStarterRecommendations() {
    return !this.starterRecommendationDismissed && !this.hasTranscript && !this.waiting && !this.buffer.trim() && this.starterRecommendations.length > 0;
  }

  insertStarterRecommendation() {
    const selected = this.starterRecommendations[0];
    if (!selected?.prompt) return false;
    this.buffer = selected.prompt;
    this.insertedStarterPrompt = selected.prompt;
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.inputHistoryIndex = null;
    this.invalidateInput();
    return true;
  }

  clearStarterRecommendation() {
    if (this.insertedStarterPrompt && this.buffer.trim() === this.insertedStarterPrompt.trim()) this.buffer = "";
    this.starterRecommendationDismissed = true;
    this.insertedStarterPrompt = "";
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.inputHistoryIndex = null;
    this.invalidateInput();
  }

  queueTextInput(str) {
    if (!shouldDeferTextInput(str) && !this.pendingInsertedText) {
      this.insertTextInput(str);
      return;
    }
    this.pendingInsertedText += str;
    if (this.pendingInsertTimer) clearTimeout(this.pendingInsertTimer);
    this.pendingInsertTimer = setTimeout(() => this.flushPendingTextInput(), 18);
  }

  flushPendingTextInput() {
    if (this.pendingInsertTimer) {
      clearTimeout(this.pendingInsertTimer);
      this.pendingInsertTimer = undefined;
    }
    if (!this.pendingInsertedText) return;
    const str = this.pendingInsertedText;
    this.pendingInsertedText = "";
    this.insertTextInput(str);
  }

  insertTextInput(str) {
    const start = this.buffer.length;
    this.buffer += str;
    this.insertedStarterPrompt = "";
    if (isLikelyPaste(str)) {
      this.pastedBlocks.push({
        id: `paste-${Date.now()}-${this.pastedBlocks.length + 1}`,
        type: "text",
        start,
        end: this.buffer.length,
        label: `[Pasted Content ${str.length.toLocaleString("en-US")} chars]`,
      });
    }
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.selectedIndex = 0;
    this.selectionDirty = false;
    this.inputHistoryIndex = null;
    this.invalidateInput();
  }

  queueImagePaste() {
    const id = `image-${Date.now()}-${this.pastedImages.length + 1}`;
    let blockIdInserted = false;
    const insertPastedImageBlock = (pastedImage) => {
      if (blockIdInserted || !pastedImage) return;
      const prefix = this.buffer && !/\s$/.test(this.buffer) ? " " : "";
      const dimensions = pastedImage.width && pastedImage.height ? ` ${pastedImage.width}x${pastedImage.height}` : "";
      const start = this.buffer.length;
      const label = `${prefix}[Pasted Image${dimensions}]`;
      this.buffer += label;
      this.pastedBlocks.push({ id, type: "image", start, end: this.buffer.length, label });
      this.pastedImages = [...this.pastedImages.filter((item) => item.id !== id), { id, image: pastedImage.image }];
      blockIdInserted = true;
      this.completedText = "";
      this.suppressSuggestionsFor = "";
      this.clearSuggestionCache();
      this.selectedIndex = 0;
      this.selectionDirty = false;
      this.inputHistoryIndex = null;
      this.invalidateInput();
    };
    const pastePromise = readClipboardImage().then(insertPastedImageBlock);
    this.imagePastePromises.add(pastePromise);
    pastePromise.finally(() => this.imagePastePromises.delete(pastePromise)).catch(() => {});
  }

  rememberInputHistory(text) {
    const value = String(text ?? "").trim();
    if (!value) return;
    this.inputHistory = this.inputHistory.filter((item) => item !== value);
    this.inputHistory.push(value);
    if (this.inputHistory.length > 100) this.inputHistory = this.inputHistory.slice(-100);
  }

  recallInputHistory(direction) {
    if (this.pastedBlocks.length > 0 || this.pastedImages.length > 0 || this.imagePastePromises.size > 0 || this.inputHistory.length === 0) return false;
    if (this.inputHistoryIndex === null) {
      if (direction > 0 || this.buffer.trim()) return false;
      this.inputHistoryDraft = this.buffer;
      this.inputHistoryIndex = this.inputHistory.length - 1;
    } else {
      this.inputHistoryIndex += direction;
    }
    if (this.inputHistoryIndex < 0) this.inputHistoryIndex = 0;
    if (this.inputHistoryIndex >= this.inputHistory.length) {
      this.inputHistoryIndex = null;
      this.buffer = this.inputHistoryDraft;
      this.inputHistoryDraft = "";
    } else {
      this.buffer = this.inputHistory[this.inputHistoryIndex];
    }
    this.insertedStarterPrompt = "";
    this.completedText = "";
    this.suppressSuggestionsFor = "";
    this.clearSuggestionCache();
    this.selectedIndex = 0;
    this.selectionDirty = false;
    return true;
  }

  invalidateInput(options = {}) {
    this.host?.invalidate({ fixedOnly: true, ...options });
  }

  clearSuggestionCache() {
    this.cachedSuggestionText = undefined;
    this.cachedSuggestions = [];
  }

  alignSelectedSuggestion(suggestions = []) {
    if (this.selectionDirty || suggestions.length === 0) return;
    const preferredIndex = suggestions.findIndex((item) => item?.selected);
    if (preferredIndex >= 0) this.selectedIndex = preferredIndex;
  }

  notifySelectedSuggestion(item) {
    const key = item ? `${item.kind ?? ""}:${item.value ?? item.label ?? ""}` : "";
    if (key === this.lastSelectedSuggestionKey) return;
    this.lastSelectedSuggestionKey = key;
    queueMicrotask(() => this.options.onSuggestionSelect?.(item));
  }

  dispose() {
    if (this.pendingInsertTimer) clearTimeout(this.pendingInsertTimer);
  }
}

function shouldShowWaitingFor(text) {
  const value = String(text ?? "").trim().toLowerCase();
  return Boolean(value && !value.startsWith("/") && value !== "exit" && value !== "quit");
}

function isLikelyPaste(value) {
  return value.length >= pastedTextThreshold || /\r|\n/.test(value);
}

function shouldDeferTextInput(value) {
  return String(value ?? "").length > 1 || isLikelyPaste(String(value ?? ""));
}

function displayTextFor(text, blocks = []) {
  const validBlocks = blocks.filter((block) => Number.isInteger(block.start) && Number.isInteger(block.end) && block.end <= text.length).sort((a, b) => a.start - b.start);
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
  const lastBlock = [...blocks].filter((block) => block.end === buffer.length).sort((a, b) => b.start - a.start)[0];
  if (!lastBlock) {
    return { buffer: buffer.slice(0, -1), blocks: blocks.filter((block) => block.end <= buffer.length - 1), images };
  }
  return {
    buffer: buffer.slice(0, lastBlock.start),
    blocks: blocks.filter((block) => block.id !== lastBlock.id && block.end <= lastBlock.start),
    images: lastBlock.type === "image" ? images.filter((item) => item.id !== lastBlock.id) : images,
  };
}

function renderInputActivityLine(frame = 0, theme = fallbackTheme, label = "working") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = frames[frame % frames.length];
  return `  ${theme.accent}${spinner}${reset} ${theme.muted}${String(label ?? "working").replace(/\s+/g, " ").trim() || "working"}${reset}`;
}

function alignMenuPreview(left, preview, width, theme = fallbackTheme) {
  if (!preview) return left;
  const hint = `${theme.muted}${preview}${reset}`;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(hint));
  return `${left}${" ".repeat(gap)}${hint}`;
}

function renderStarterRecommendationLine(item, width, theme = fallbackTheme) {
  const prompt = String(item?.prompt ?? "").trim();
  if (!prompt) return "";
  const prefixText = width >= 42 ? "maybe start with " : "try ";
  const hintText = width >= 52 ? " - up uses it, down clears it" : width >= 34 ? " - up use, down clear" : "";
  const prefix = `${theme.muted}${prefixText}${reset}`;
  const hint = hintText ? `${theme.muted}${hintText}${reset}` : "";
  const available = Math.max(4, width - visibleWidth(prefix) - visibleWidth(hint));
  return `${prefix}${theme.primary}${truncatePlain(prompt, available)}${reset}${hint}`;
}

function renderEditorLines({ prompt, text = "", placeholder = "message..." }, width, theme = fallbackTheme) {
  const promptWidth = visibleWidth(prompt);
  const rowWidth = Math.max(1, width - promptWidth);
  if (!text) {
    return {
      lines: [`${prompt} ${theme.muted}${placeholder}${reset}`],
      cursor: { row: 0, col: promptWidth },
    };
  }
  const rows = wrapEditorInput(text, rowWidth);
  return {
    lines: rows.map((row, index) => `${index === 0 ? prompt : " ".repeat(promptWidth)}${row}`),
    cursor: {
      row: Math.max(0, rows.length - 1),
      col: promptWidth + visibleWidth(rows.at(-1) ?? ""),
    },
  };
}

function renderInputRail(width, theme = fallbackTheme) {
  return `${theme.editorBorder}${"─".repeat(Math.max(1, width))}${reset}`;
}

function wrapEditorInput(text, width) {
  const max = Math.max(1, Number(width) || 1);
  const rows = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    const tokens = paragraph.match(/\S+|\s+/g) ?? [""];
    let row = "";
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (!row) continue;
        if (visibleWidth(row) + visibleWidth(token) <= max) {
          row += token;
        } else {
          rows.push(row.trimEnd());
          row = "";
        }
        continue;
      }

      let word = token;
      while (visibleWidth(word) > max) {
        if (row) {
          rows.push(row.trimEnd());
          row = "";
        }
        rows.push(word.slice(0, max));
        word = word.slice(max);
      }

      if (visibleWidth(row) + visibleWidth(word) > max && row) {
        rows.push(row.trimEnd());
        row = word;
      } else {
        row += word;
      }
    }
    rows.push(row.trimEnd());
  }
  return rows;
}

function styleAttachmentLabels(text, theme = fallbackTheme, restore = fgReset) {
  return String(text).replace(/\[(Pasted Image[^\]]*|Pasted Content[^\]]*)\]/g, (_match, inner) => {
    return `${theme.muted}[${theme.accent}${bold}${inner}${normalIntensity}${theme.muted}]${restore}`;
  });
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
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => done(null));
    child.on("close", (status) => {
      if (status !== 0 || !stdout.trim()) return done(null);
      try {
        const payload = JSON.parse(stdout.trim());
        if (!payload?.data || !payload?.mimeType) return done(null);
        done({ width: payload.width, height: payload.height, image: { type: "image", data: payload.data, mimeType: payload.mimeType } });
      } catch {
        done(null);
      }
    });
  });
}

function pickPlaceholder(previous = "") {
  const values = inputPlaceholders.filter((value) => typeof value === "string" && value.trim());
  if (values.length === 0) return "message...";
  if (values.length === 1) return values[0];
  let next = values[Math.floor(Math.random() * values.length)];
  if (next === previous) next = values[(values.indexOf(next) + 1) % values.length];
  return next;
}

function normalizeStarterRecommendations(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => typeof item === "string"
      ? { prompt: item.trim(), description: "" }
      : { prompt: String(item?.prompt ?? item?.value ?? "").trim(), description: String(item?.description ?? item?.why ?? "").trim() })
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
