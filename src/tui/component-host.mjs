import readline from "node:readline";
import { stdout as defaultOutput } from "node:process";
import {
  alternateScreenEnd,
  alternateScreenStart,
  clearScreen,
  countPhysicalRows,
  hideCursor,
  physicalRowsForLine,
  renderLinesWithinWidth,
  showCursor,
  syncEnd,
  syncStart,
  terminalRenderHeight,
  terminalRenderWidth,
} from "./render-utils.mjs";

const renderDebounceMs = 16;

export class CaraComponentHost {
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
    this.autoRender = Boolean(options.autoRender);
    this.useAlternateScreen = options.useAlternateScreen ?? true;
    this.alternateScreenActive = false;
  }

  width() {
    return terminalRenderWidth(this.output, 1);
  }

  height() {
    return terminalRenderHeight(this.output);
  }

  setInteractive(value) {
    this.interactive = Boolean(value);
    if (this.interactive) {
      if (this.useAlternateScreen && !this.alternateScreenActive) {
        this.output.write(`${alternateScreenStart}${clearScreen}`);
        this.alternateScreenActive = true;
        this.renderedLines = [];
        this.renderedPhysicalRows = 0;
        this.lastOutput = "";
      }
      this.output.write(`${hideCursor}`);
    }
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
    if (this.components.length !== before) this.invalidate();
  }

  clearComponents() {
    this.components = [];
    this.invalidate({ force: true });
  }

  writeRaw(text = "") {
    if (this.interactive) {
      this.clearRendered();
    }
    this.output.write(String(text ?? ""));
    if (this.interactive) this.invalidate({ force: true });
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
    this.previousWidth = width;
    this.previousHeight = height;

    const allLines = this.renderLines(width);
    const lines = this.interactive ? visibleViewportLines(allLines, width, height) : allLines;
    const output = lines.join("\n");

    if (!this.interactive) {
      if (!output) return;
      this.output.write(output.endsWith("\n") ? output : `${output}\n`);
      this.components = this.components.filter((component) => component.persistent !== false);
      return;
    }

    if (!resized && !options.force && output === this.lastOutput) return;

    this.beginBatch();
    this.clearRendered(width);
    if (output) this.output.write(output);
    this.endBatch();
    this.renderedLines = [...lines];
    this.renderedPhysicalRows = countPhysicalRows(lines, width);
    this.lastOutput = output;
  }

  renderLines(width = this.width()) {
    const lines = [];
    for (const component of this.components) {
      if (component.hidden) continue;
      lines.push(...safeRender(component, width));
    }
    if (this.inputComponent) lines.push(...safeRender(this.inputComponent, width));
    if (this.footerComponent) lines.push(...safeRender(this.footerComponent, width));
    return renderLinesWithinWidth(lines, width);
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
    this.renderedPhysicalRows = 0;
    this.lastOutput = "";
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
    if (this.interactive) {
      this.clearRendered();
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

function safeRender(component, width) {
  const lines = component.render?.(width);
  return Array.isArray(lines) ? lines : [];
}

function visibleViewportLines(lines, width, height) {
  const maxRows = Math.max(1, Number(height) || 1);
  const kept = [];
  let rows = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineRows = physicalRowsForLine(line, width);
    if (kept.length > 0 && rows + lineRows > maxRows) break;
    kept.unshift(line);
    rows += lineRows;
    if (rows >= maxRows) break;
  }

  return kept;
}
