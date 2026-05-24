import readline from "node:readline";
import { stdout as defaultOutput } from "node:process";
import {
  alternateScreenEnd,
  alternateScreenStart,
  clearScreen,
  countPhysicalRows,
  hideCursor,
  renderLinesWithinWidth,
  showCursor,
  syncEnd,
  syncStart,
  terminalRenderHeight,
  terminalRenderWidth,
} from "./render-utils.mjs";

const renderDebounceMs = 16;

export class ZyraComponentHost {
  constructor(options = {}) {
    this.output = options.output ?? defaultOutput;
    this.components = [];
    this.inputComponent = null;
    this.footerComponent = null;
    this.renderedLines = [];
    this.renderedPhysicalRows = 0;
    this.previousWidth = this.width();
    this.previousHeight = this.height();
    this.renderTimer = undefined;
    this.interactive = false;
    this.batchOpen = false;
    this.lastOutput = "";
    this.lastContentOutput = "";
    this.lastFixedOutput = "";
    this.autoRender = Boolean(options.autoRender);
    this.useAlternateScreen = options.useAlternateScreen ?? false;
    this.alternateScreenActive = false;
    this.contentDirty = true;
    this.contentLinesCache = [];
    this.contentCacheWidth = 0;
    this.contentPhysicalRowsCache = 0;
    this.renderedContentLines = [];
    this.renderedFixedLines = [];
  }

  width() {
    return terminalRenderWidth(this.output, 1);
  }

  height() {
    return terminalRenderHeight(this.output);
  }

  markContentDirty() {
    this.contentDirty = true;
  }

  setInteractive(value) {
    this.interactive = Boolean(value);
    if (this.interactive) {
      if (this.useAlternateScreen && !this.alternateScreenActive) {
        this.output.write(`${alternateScreenStart}${clearScreen}`);
        this.alternateScreenActive = true;
        this.renderedLines = [];
        this.renderedContentLines = [];
        this.renderedFixedLines = [];
        this.renderedPhysicalRows = 0;
        this.lastOutput = "";
        this.lastContentOutput = "";
        this.lastFixedOutput = "";
      }
      this.output.write(`${hideCursor}`);
    }
  }

  markRendered(width = this.width()) {
    const { contentLines, fixedLines, lines } = this.renderParts(width);
    const contentOutput = contentLines.join("\n");
    const fixedOutput = fixedLines.join("\n");
    this.rememberRenderedParts(contentLines, fixedLines, width, {
      contentOutput,
      fixedOutput,
      output: lines.join("\n"),
      replaceContent: true,
    });
    this.previousWidth = width;
    this.previousHeight = this.height();
  }

  setInputComponent(component) {
    this.inputComponent = component;
    component?.setHost?.(this);
    this.invalidate({ force: true });
  }

  setFooterComponent(component) {
    this.footerComponent = component;
    component?.setHost?.(this);
    this.invalidate();
  }

  append(component) {
    component?.setHost?.(this);
    this.components.push(component);
    this.contentDirty = true;
    this.invalidate();
    return component;
  }

  upsert(key, factory) {
    const existing = this.components.find((component) => component.key === key);
    if (existing) return existing;
    return this.append(factory());
  }

  remove(key) {
    const before = this.components.length;
    this.components = this.components.filter((component) => component.key !== key);
    if (this.components.length !== before) {
      this.contentDirty = true;
      this.invalidate();
    }
  }

  clearComponents(options = {}) {
    this.components = [];
    this.contentDirty = true;
    this.invalidate({ force: true, clear: Boolean(options.clear) });
  }

  replaceComponents(components = [], options = {}) {
    this.components = components.filter(Boolean);
    for (const component of this.components) component?.setHost?.(this);
    this.contentDirty = true;
    this.invalidate({ force: true, clear: Boolean(options.clear) });
  }

  writeRaw(text = "") {
    if (this.interactive) {
      this.clearRendered();
    }
    this.output.write(String(text ?? ""));
    if (this.interactive) {
      this.contentDirty = true;
      this.invalidate({ force: true });
    }
  }

  printLines(lines = []) {
    if (!this.interactive && !this.autoRender) {
      const text = (Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/)).join("\n");
      if (text) this.output.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const component = new StaticLinesComponent(`static-${Date.now()}-${this.components.length}`, lines);
    this.append(component);
  }

  invalidate(options = {}) {
    if (!options.fixedOnly) this.contentDirty = true;
    if (!this.interactive) {
      if (!this.autoRender) return;
      this.render(options);
      return;
    }
    if (options.force) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.render(options);
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render(options);
    }, renderDebounceMs);
  }

  render(options = {}) {
    const width = this.width();
    const height = this.height();
    const resized = width !== this.previousWidth || height !== this.previousHeight;
    if (resized) this.contentDirty = true;
    this.previousWidth = width;
    this.previousHeight = height;

    if (this.shouldRenderFixedOnly(options, width, resized)) {
      const contentLines = this.renderContentLines(width);
      const fixedLines = this.renderFixedLines(width);
      const fixedOutput = fixedLines.join("\n");
      if (fixedOutput === this.lastFixedOutput && contentLines.length === this.renderedContentLines.length) return;
      this.diffRenderFixed(contentLines, fixedLines);
      this.rememberRenderedParts(contentLines, fixedLines, width, { fixedOutput });
      return;
    }

    const { contentLines, fixedLines, lines } = this.renderParts(width);
    const contentOutput = contentLines.join("\n");
    const fixedOutput = fixedLines.join("\n");
    const output = lines.join("\n");

    if (!this.interactive) {
      if (!output) return;
      this.output.write(output.endsWith("\n") ? output : `${output}\n`);
      this.components = this.components.filter((component) => component.persistent !== false);
      return;
    }

    if (!resized && contentOutput === this.lastContentOutput && fixedOutput === this.lastFixedOutput) return;

    if (resized || options.clear) this.fullRender(lines, { clear: true });
    else this.diffRender(lines);
    this.rememberRenderedParts(contentLines, fixedLines, width, {
      contentOutput,
      fixedOutput,
      output,
      replaceContent: true,
    });
  }

  renderLines(width = this.width()) {
    return this.renderParts(width).lines;
  }

  renderParts(width = this.width()) {
    const contentLines = this.renderContentLines(width);
    const fixedLines = this.renderFixedLines(width);
    return {
      contentLines,
      fixedLines,
      lines: renderLinesWithinWidth([...contentLines, ...fixedLines], width),
    };
  }

  renderContentLines(width = this.width()) {
    if (!this.contentDirty && this.contentCacheWidth === width) return this.contentLinesCache;
    const lines = [];
    let previousSpacingKind = "";
    for (const component of this.components) {
      if (component.hidden) continue;
      const rendered = safeRender(component, width);
      if (previousSpacingKind === "tool" && component.spacingKind === "tool" && lines.at(-1) === "" && rendered[0] === "") {
        rendered.shift();
      }
      lines.push(...rendered);
      if (rendered.length > 0) previousSpacingKind = component.spacingKind ?? "";
    }
    const renderedLines = renderLinesWithinWidth(lines, width);
    this.contentLinesCache = renderedLines;
    this.contentCacheWidth = width;
    this.contentPhysicalRowsCache = countPhysicalRows(renderedLines, width);
    this.contentDirty = false;
    return renderedLines;
  }

  renderFixedLines(width = this.width()) {
    const lines = [];
    if (this.inputComponent) lines.push(...safeRender(this.inputComponent, width));
    if (this.footerComponent) lines.push(...safeRender(this.footerComponent, width));
    return renderLinesWithinWidth(lines, width);
  }

  scrollBy(rows) {
    void rows;
    return false;
  }

  scrollToBottom() {
    return false;
  }

  scrollToTop() {
    return false;
  }

  canScroll() {
    return false;
  }

  fullRender(lines, options = {}) {
    this.beginBatch();
    if (options.clear) this.output.write(`${clearScreen}\x1b[3J`);
    const output = lines.join("\n");
    if (output) this.output.write(output);
    this.endBatch();
  }

  shouldRenderFixedOnly(options = {}, width = this.width(), resized = false) {
    return Boolean(
      this.interactive
      && options.fixedOnly
      && !resized
      && !this.contentDirty
      && this.contentCacheWidth === width
      && this.renderedLines.length > 0,
    );
  }

  diffRender(lines) {
    if (this.renderedLines.length === 0) {
      this.fullRender(lines, { clear: false });
      return;
    }

    const previous = this.renderedLines;
    let firstChanged = -1;
    const max = Math.max(previous.length, lines.length);
    for (let index = 0; index < max; index += 1) {
      if ((previous[index] ?? "") !== (lines[index] ?? "")) {
        firstChanged = index;
        break;
      }
    }
    if (firstChanged === -1) return;

    const viewportTop = Math.max(0, previous.length - this.height());
    if (firstChanged < viewportTop) {
      const visibleFirstChanged = firstChangedLine(previous, lines, viewportTop);
      if (visibleFirstChanged === -1) return;
      this.diffRenderTail(visibleFirstChanged, lines.slice(visibleFirstChanged), previous.length, lines.length);
      return;
    }

    const rowsUp = Math.max(0, previous.length - firstChanged - 1);
    let buffer = "";
    if (rowsUp > 0) buffer += `\x1b[${rowsUp}A`;
    buffer += firstChanged >= previous.length && previous.length > 0 ? "\r\n" : "\r";

    for (let index = firstChanged; index < lines.length; index += 1) {
      if (index > firstChanged) buffer += "\r\n";
      buffer += `\x1b[2K${lines[index]}`;
    }
    if (previous.length > lines.length) buffer += "\x1b[J";

    this.beginBatch();
    this.output.write(buffer);
    this.endBatch();
  }

  diffRenderFixed(contentLines = [], fixedLines = []) {
    if (this.renderedLines.length === 0 || this.renderedContentLines.length !== contentLines.length) {
      this.fullRender([...contentLines, ...fixedLines], { clear: false });
      return;
    }

    const previousFixed = this.renderedFixedLines;
    let firstChanged = -1;
    const max = Math.max(previousFixed.length, fixedLines.length);
    for (let index = 0; index < max; index += 1) {
      if ((previousFixed[index] ?? "") !== (fixedLines[index] ?? "")) {
        firstChanged = index;
        break;
      }
    }
    if (firstChanged === -1) return;

    const previousTotal = this.renderedContentLines.length + previousFixed.length;
    const nextTotal = contentLines.length + fixedLines.length;
    const globalFirstChanged = contentLines.length + firstChanged;
    const viewportTop = Math.max(0, previousTotal - this.height());
    if (globalFirstChanged < viewportTop) {
      this.fullRender([...contentLines, ...fixedLines], { clear: true });
      return;
    }

    this.diffRenderTail(globalFirstChanged, fixedLines.slice(firstChanged), previousTotal, nextTotal);
  }

  diffRenderTail(firstChanged, tailLines = [], previousTotal, nextTotal) {
    const rowsUp = Math.max(0, previousTotal - firstChanged - 1);
    let buffer = "";
    if (rowsUp > 0) buffer += `\x1b[${rowsUp}A`;
    buffer += firstChanged >= previousTotal && previousTotal > 0 ? "\r\n" : "\r";

    for (let index = 0; index < tailLines.length; index += 1) {
      if (index > 0) buffer += "\r\n";
      buffer += `\x1b[2K${tailLines[index]}`;
    }
    if (previousTotal > nextTotal) buffer += "\x1b[J";

    this.beginBatch();
    this.output.write(buffer);
    this.endBatch();
  }

  rememberRenderedParts(contentLines = [], fixedLines = [], width = this.width(), options = {}) {
    const replaceContent = options.replaceContent
      || this.renderedContentLines.length !== contentLines.length
      || this.renderedLines.length < contentLines.length;

    if (replaceContent) {
      this.renderedContentLines = [...contentLines];
      this.renderedLines = [...contentLines, ...fixedLines];
    } else {
      this.renderedLines.length = this.renderedContentLines.length + fixedLines.length;
      for (let index = 0; index < fixedLines.length; index += 1) {
        this.renderedLines[this.renderedContentLines.length + index] = fixedLines[index];
      }
    }

    this.renderedFixedLines = [...fixedLines];
    this.renderedPhysicalRows = this.contentPhysicalRowsCache + countPhysicalRows(fixedLines, width);
    if (options.contentOutput !== undefined) this.lastContentOutput = options.contentOutput;
    if (options.fixedOutput !== undefined) this.lastFixedOutput = options.fixedOutput;
    if (options.output !== undefined) this.lastOutput = options.output;
  }

  clearRendered(width = this.width()) {
    if (this.renderedPhysicalRows <= 0 && this.renderedLines.length === 0) return;
    const rowsAtCurrentWidth = countPhysicalRows(this.renderedLines, width);
    const maxOwnedRows = Math.max(1, this.height());
    const rowsToMove = Math.min(Math.max(this.renderedPhysicalRows, rowsAtCurrentWidth), maxOwnedRows) - 1;
    if (rowsToMove > 0) readline.moveCursor(this.output, 0, -rowsToMove);
    readline.cursorTo(this.output, 0);
    readline.clearScreenDown(this.output);
    this.renderedLines = [];
    this.renderedContentLines = [];
    this.renderedFixedLines = [];
    this.renderedPhysicalRows = 0;
    this.lastOutput = "";
    this.lastContentOutput = "";
    this.lastFixedOutput = "";
  }

  beginBatch() {
    if (this.batchOpen) return;
    this.output.write(`${hideCursor}${syncStart}`);
    this.batchOpen = true;
  }

  endBatch(showHardwareCursor = false) {
    if (!this.batchOpen) return;
    this.output.write(`${syncEnd}${showHardwareCursor ? showCursor : hideCursor}`);
    this.batchOpen = false;
  }

  dispose() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.endBatch(true);
    if (this.interactive && this.alternateScreenActive) {
      this.clearRendered();
      this.output.write(showCursor);
    } else if (this.interactive) {
      this.output.write(showCursor);
    }
    if (this.alternateScreenActive) {
      this.output.write(`${clearScreen}${alternateScreenEnd}`);
      this.alternateScreenActive = false;
    } else if (this.interactive) {
      this.output.write("\n");
    }
    this.interactive = false;
  }
}

export class StaticLinesComponent {
  constructor(key, lines = [], options = {}) {
    this.key = key;
    this.lines = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);
    this.persistent = options.persistent ?? true;
  }

  setLines(lines) {
    this.lines = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);
    this.host?.invalidate();
  }

  setHost(host) {
    this.host = host;
  }

  render() {
    return this.lines;
  }
}

export const CaraComponentHost = ZyraComponentHost;

function safeRender(component, width) {
  const lines = component.render?.(width);
  return Array.isArray(lines) ? lines : [];
}

function firstChangedLine(previous = [], next = [], start = 0) {
  const max = Math.max(previous.length, next.length);
  for (let index = Math.max(0, start); index < max; index += 1) {
    if ((previous[index] ?? "") !== (next[index] ?? "")) return index;
  }
  return -1;
}
