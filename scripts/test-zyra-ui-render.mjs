#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSlashSuggestions } from "../src/slash-suggestions.mjs";
import { AssistantMessageLifecycle, createZyraUi, mergeAssistantTextDelta } from "../src/zyra-ui.mjs";
import { setZyraTheme } from "../src/zyra-sdk.mjs";
import { renderStatusLine } from "../src/status-line.mjs";
import { buildTerminalTheme } from "../src/terminal-theme.mjs";
import { renderAccountStatusBox, renderCodexUsageBox, renderStatusBox } from "../src/terminal-blocks.mjs";
import { ZyraComponentHost, EditorComponent, StaticLinesComponent, renderToolBlock } from "../src/tui/zyra-tui.mjs";
import { stripAnsi } from "../src/tui/render-utils.mjs";

function assistantMessage(text = "", id = "assistant-1") {
  return { id, role: "assistant", content: text ? [{ type: "text", text }] : [] };
}

function updateEvent(text, delta, id = "assistant-1") {
  return {
    type: "message_update",
    message: assistantMessage(text, id),
    assistantMessageEvent: delta === undefined ? { type: "text_start" } : { type: "text_delta", delta },
  };
}

function deltaOnlyEvent(delta, id = "assistant-1") {
  return {
    type: "message_update",
    message: assistantMessage("", id),
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

function runDeltaStreamingRegression() {
  const lifecycle = new AssistantMessageLifecycle();
  lifecycle.start(assistantMessage());
  lifecycle.update(updateEvent("Yep.", "Yep."));
  lifecycle.update(updateEvent("Yep. Here", " Here"));

  assert.equal(lifecycle.hasTransient(), true);
  assert.equal(lifecycle.getTransient().text, "Yep. Here");

  const committed = lifecycle.end(assistantMessage("Yep. Here"));
  assert.equal(committed.text, "Yep. Here");
  assert.equal(lifecycle.hasTransient(), false);
  assert.equal(lifecycle.end(assistantMessage("Yep. Here")), null, "same final assistant message must not commit twice");
}

function runFullSnapshotRegression() {
  const lifecycle = new AssistantMessageLifecycle();
  lifecycle.start(assistantMessage());

  const snapshots = [
    "Yep. Here’s the useful recap:",
    "Yep. Here’s the useful recap:\n\nYou asked where the original Zyra project was.",
    "Yep. Here’s the useful recap:\n\nYou asked where the original Zyra project was. I found:",
  ];

  for (const snapshot of snapshots) {
    lifecycle.update(updateEvent(snapshot));
    assert.equal(lifecycle.getTransient().text, snapshot);
  }

  const committed = lifecycle.end(assistantMessage(snapshots.at(-1)));
  assert.equal(committed.text, snapshots.at(-1));
  assert.equal(lifecycle.hasTransient(), false);
}

function runRepeatedSnapshotRegression() {
  const lifecycle = new AssistantMessageLifecycle();
  lifecycle.start(assistantMessage());

  const snapshot = "```text\nC:\\Users\\elson\\my_coding_play\\playground\\Cara's agent\n```";
  lifecycle.update(updateEvent(snapshot));
  lifecycle.update(updateEvent(snapshot));
  lifecycle.update(updateEvent(snapshot));

  assert.equal(lifecycle.getTransient().text, snapshot, "repeated identical snapshots keep one authoritative message state");
  const committed = lifecycle.end(assistantMessage(snapshot));
  assert.equal(committed.text, snapshot);
  assert.equal(lifecycle.end(assistantMessage(snapshot)), null);
}

function runMarkdownCodeBlockRegression() {
  const lifecycle = new AssistantMessageLifecycle();
  lifecycle.start(assistantMessage());
  const markdown = [
    "Strong delete candidates:",
    "",
    "```text",
    "C:\\Users\\elson\\my_coding_play\\playground\\clean-dashboard-preview",
    "C:\\Users\\elson\\my_coding_play\\playground\\docs",
    "```",
  ].join("\n");

  lifecycle.update(updateEvent(markdown));
  assert.equal(lifecycle.getTransient().text, markdown);
  assert.equal(lifecycle.end(assistantMessage(markdown)).text, markdown);
}

function runMergeHelperRegression() {
  assert.equal(mergeAssistantTextDelta("Yep.", " Yep again."), "Yep. Yep again.");
  assert.equal(mergeAssistantTextDelta("Yep.", "Yep."), "Yep.");
  assert.equal(mergeAssistantTextDelta("Yep.", "Yep. Here"), "Yep. Here");
  assert.equal(mergeAssistantTextDelta("Sure.", "Sure.\n\nThe day arrives"), "Sure.\n\nThe day arrives");
  assert.equal(mergeAssistantTextDelta("Sure.\n\nSure.", "Sure.\n\nThe day arrives"), "Sure.\n\nThe day arrives");
  assert.equal(mergeAssistantTextDelta("The day arrives", "arrives without asking"), "The day arrives without asking");
}

function runSnapshotDeltaPollutionRegression() {
  const lifecycle = new AssistantMessageLifecycle();
  lifecycle.start(assistantMessage());

  lifecycle.update(deltaOnlyEvent("Sure."));
  lifecycle.update(deltaOnlyEvent("Sure.\n\nThe day arrives without asking,"));
  lifecycle.update(deltaOnlyEvent("Sure.\n\nThe day arrives without asking,\nsoft-footed at the window,"));

  assert.equal(
    lifecycle.getTransient().text,
    "Sure.\n\nThe day arrives without asking,\nsoft-footed at the window,",
    "snapshot-shaped text_delta events must replace/overlap, not append repeated prefixes",
  );
}

function captureStdout(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk, encoding, callback) => {
    captured += String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    fn(() => captured);
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured;
}

function runUiEventCaptureRegression() {
  const captured = captureStdout((getCaptured) => {
    const ui = createZyraUi();
    ui.event({ type: "message_start", message: assistantMessage() });
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:\n\nYou asked where the original Zyra project was."));
    ui.event({
      type: "message_end",
      message: assistantMessage("Yep. Here’s the useful recap:"),
    });
    assert.equal(getCaptured().includes("Yep"), false, "assistant text must not print before the turn boundary");
    ui.event({
      type: "message_end",
      message: assistantMessage("Yep. Here’s the useful recap:\n\nYou asked where the original Zyra project was."),
    });
    assert.equal(getCaptured().includes("Yep"), false, "later message_end snapshots must still wait for agent_end/turn_end");
    ui.event({ type: "agent_end" });
    ui.event({ type: "agent_end" });
  });

  assert.equal(
    (captured.match(/Yep/g) ?? []).length,
    1,
    `UI event path must commit the assistant answer once, not redraw snapshots into transcript. Captured:\n${captured}`,
  );
  assert.match(captured, /You asked where the original Zyra project was/);
}

function runToolOutputStyleRegression() {
  const captured = captureStdout(() => {
    const ui = createZyraUi();
    ui.event({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tool-1",
      args: { command: "git remote -v" },
      result: {
        content: [{ type: "text", text: "origin https://github.com/justelson/elxnplus.git (fetch)" }],
      },
    });
  });

  assert.equal(captured.includes("summary ..."), false);
  assert.equal(captured.includes("╭"), false, "tool output should not use the accidental new rounded-box style");
  assert.match(stripAnsi(captured), /bash succeeded/);
  assert.match(stripAnsi(captured), /git remote -v/);
}

function runToolCallThemeStylingRegression() {
  const theme = buildTerminalTheme({
    name: "tool-style-test",
    colors: {
      primary: "#654321",
      success: "#00aa00",
      warning: "#aa7700",
      error: "#aa0000",
      muted: "#555555",
      accent: "#abcdef",
      toolCall: {
        background: "#010203",
        successBackground: "#020304",
        errorBackground: "#030405",
        rail: "#123456",
        marker: "#234567",
        name: "#654321",
        running: "#abcdef",
        success: "#00ff00",
        error: "#ff0000",
        args: "#777777",
        output: "#888888",
      },
    },
  });

  const running = renderToolBlock({
    state: "running",
    toolName: "bash",
    args: { command: "git status --short" },
    partialResult: { content: [{ type: "text", text: "running" }] },
  }, theme, 80).join("\n");

  assert.match(running, /\x1b\[48;2;1;2;3m/, "running tool rows should use theme toolCall.background");
  assert.match(running, /\x1b\[38;2;35;69;103m>/, "tool marker should use theme toolCall.marker");
  assert.match(running, /\x1b\[1m\x1b\[38;2;101;67;33mbash/, "tool name should use theme toolCall.name");
  assert.match(running, /\x1b\[38;2;171;205;239mrunning/, "running state should use theme toolCall.running");
  assert.match(running, /\x1b\[38;2;119;119;119mcmd  git status --short/, "tool args should use theme toolCall.args");
  assert.match(running, /\x1b\[38;2;136;136;136mrunning/, "tool output should use theme toolCall.output");
  assert.equal(
    running.split("\n").every((line) => stripAnsi(line).length <= 80),
    true,
    "styled tool rows must still fit the render width",
  );

  const done = renderToolBlock({ state: "done", toolName: "read" }, theme, 80).join("\n");
  const failed = renderToolBlock({ state: "error", toolName: "write", isError: true }, theme, 80).join("\n");
  assert.match(done, /\x1b\[48;2;2;3;4m/, "done tool rows should use theme toolCall.successBackground");
  assert.match(done, /\x1b\[38;2;0;255;0msucceeded/, "done state should use theme toolCall.success");
  assert.match(failed, /\x1b\[48;2;3;4;5m/, "failed tool rows should use theme toolCall.errorBackground");
  assert.match(failed, /\x1b\[38;2;255;0;0mfailed/, "error state should use theme toolCall.error");

  const fallbackTheme = buildTerminalTheme({
    name: "old-theme-shape",
    colors: {
      primary: "#123123",
      success: "#00aa00",
      warning: "#aa7700",
      error: "#aa0000",
      muted: "#555555",
      accent: "#abcdef",
    },
  });
  const fallback = renderToolBlock({ state: "running", toolName: "bash" }, fallbackTheme, 80).join("\n");
  assert.match(fallback, /\x1b\[/, "older themes without toolCall should still get derived tool styling");
}

function runInteractiveAssistantComponentRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "turn_start" });
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("Yep."));
  ui.event(updateEvent("Yep."));
  ui.event(updateEvent("Yep. Here"));
  ui.event({
    type: "message_end",
    message: assistantMessage("Yep. Here"),
  });
  ui.event({ type: "turn_end" });

  const plain = ui._debugRenderLinesForTests(80).map(stripAnsi).join("\n");
  assert.equal((plain.match(/Yep/g) ?? []).length, 1, "interactive assistant snapshots mutate one component");
  assert.match(plain, /Yep\. Here/);
}

function runInteractiveNoTurnEndDuplicateRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "turn_start" });
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("Final answer"));
  ui.event({ type: "message_end", message: assistantMessage("Final answer") });
  const before = ui._debugRenderLinesForTests(80).map(stripAnsi).join("\n");
  ui.event({ type: "agent_end" });
  ui.event({ type: "turn_end" });
  const after = ui._debugRenderLinesForTests(80).map(stripAnsi).join("\n");

  assert.equal((before.match(/Final answer/g) ?? []).length, 1);
  assert.equal((after.match(/Final answer/g) ?? []).length, 1, "turn_end/agent_end must not append a delayed duplicate");
}

function runInteractiveToolComponentRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "tool-1",
    args: { command: "git status --short" },
  });
  ui.event({
    type: "tool_execution_update",
    toolName: "bash",
    toolCallId: "tool-1",
    args: { command: "git status --short" },
    partialResult: { content: [{ type: "text", text: "running" }] },
  });
  ui.event({
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "tool-1",
    args: { command: "git status --short" },
    result: { content: [{ type: "text", text: "clean" }] },
  });
  const plain = ui._debugRenderLinesForTests(80).map(stripAnsi).join("\n");
  assert.equal((plain.match(/bash/g) ?? []).length, 1, "tool start/update/end must keep one rendered tool row group");
  assert.match(plain, /git status --short/);
  assert.match(plain, /clean/);
}

function runRunningToolStartsImmediatelyRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({
    type: "tool_execution_start",
    toolName: "edit",
    toolCallId: "edit-1",
    args: {
      path: "src/example.mjs",
      oldString: "const value = 1;",
      newString: "const value = 2;\nconst ready = true;",
    },
  });

  const plain = ui._debugRenderLinesForTests(90).map(stripAnsi).join("\n");
  assert.match(plain, /edit running/, "tool start should render immediately as running");
  assert.match(plain, /path src\/example\.mjs/);
  assert.match(plain, /edit replace/);
  assert.match(plain, /--- before/);
  assert.match(plain, /- const value = 1;/);
  assert.match(plain, /\+\+\+ after/);
  assert.match(plain, /\+ const value = 2;/);
  assert.match(plain, /status started/);
}

function runWriteToolRicherRepresentationRegression() {
  const plainLines = renderToolBlock({
    state: "running",
    toolName: "write",
    args: {
      path: "notes.md",
      content: "first line\nsecond line\nthird line",
    },
  }, undefined, 90).map(stripAnsi);
  const meaningful = plainLines.filter((line) => line.trim().length > 0);

  assert.ok(meaningful.length > 3, "write tool should render more than title/path/status");
  assert.equal(meaningful.some((line) => line.includes("write running")), true);
  assert.equal(meaningful.some((line) => line.includes("path notes.md")), true);
  assert.equal(meaningful.some((line) => line.includes("write 3 lines")), true);
  assert.equal(meaningful.some((line) => line.includes("+++ content")), true);
  assert.equal(meaningful.some((line) => line.includes("+ first line")), true);
  assert.equal(meaningful.some((line) => line.includes("status started")), true);
}

function runConsecutiveToolSpacingRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "tool-a",
    args: { path: "a.txt" },
    result: { content: [{ type: "text", text: "a-output" }] },
  });
  ui.event({
    type: "tool_execution_end",
    toolName: "write",
    toolCallId: "tool-b",
    args: { path: "b.txt" },
    result: { content: [{ type: "text", text: "b-output" }] },
  });

  const lines = ui._debugRenderLinesForTests(80).map(stripAnsi);
  const firstEnd = lines.findIndex((line) => line.includes("a-output"));
  const secondStart = lines.findIndex((line) => line.includes("write succeeded"));
  assert.ok(firstEnd >= 0, "first tool output should render");
  assert.ok(secondStart > firstEnd, "second tool should render after first tool");
  assert.deepEqual(lines.slice(firstEnd + 1, secondStart), [""], "consecutive tool calls should have exactly one blank line between them");
}

function runAssistantAndToolInterleaveRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "turn_start" });
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("Reading files..."));
  ui.event({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "tool-read",
    args: { path: "src/zyra-ui.mjs" },
  });
  ui.event(updateEvent("Reading files...\n\nFound it."));
  ui.event({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "tool-read",
    args: { path: "src/zyra-ui.mjs" },
    result: { content: [{ type: "text", text: "export function createZyraUi" }] },
  });
  const plain = ui._debugRenderLinesForTests(70).map(stripAnsi).join("\n");
  assert.equal((plain.match(/Reading files/g) ?? []).length, 1, "assistant stream should not become raw interleaved blocks");
  assert.equal((plain.match(/read/g) ?? []).length, 1, "tool output should stay in its keyed component");
}

function runWidthFitRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("A very long assistant line that should wrap or clamp without exceeding the requested render width."));
  ui.event({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "tool-width",
    args: { command: "node scripts/test-zyra-ui-render.mjs --with-a-very-long-argument-that-needs-clamping" },
  });
  for (const width of [32, 56, 100]) {
    const lines = ui._debugRenderLinesForTests(width);
    assert.equal(
      lines.every((line) => stripAnsi(line).length <= width),
      true,
      `all component-rendered lines must fit width ${width}`,
    );
  }
}

function runStaticPanelsThroughHostRegression() {
  const ui = createZyraUi();
  ui._debugBeginInteractiveForTests();
  ui.status({
    model: "openai-codex/gpt-5.5",
    project: "C:\\Users\\elson\\my_coding_play\\playground\\Cara's agent",
    profile: "elson",
    thinking: "medium",
    terminalTheme: "rose-pine",
    usage: {},
  });
  ui.commands();
  const plain = ui._debugRenderLinesForTests(90).map(stripAnsi).join("\n");
  assert.match(plain, /Zyra session/);
  assert.match(plain, /Slash commands/);
}

function runResizeFullRedrawRegression() {
  const writes = [];
  const fakeOutput = {
    columns: 42,
    rows: 18,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
    cursorTo() {
      writes.push("[cursorTo]");
    },
    moveCursor() {
      writes.push("[moveCursor]");
    },
    clearScreenDown() {
      writes.push("[clearScreenDown]");
    },
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  host.setInteractive(true);
  host.append(new StaticLinesComponent("line", ["prompt-with-a-long-tail-that-wraps-at-narrow-width"]));
  host.invalidate({ force: true });
  const narrowOutput = host.lastOutput;
  fakeOutput.columns = 90;
  host.invalidate({ force: true });
  const wideOutput = host.lastOutput;

  assert.notEqual(narrowOutput, wideOutput, "width changes must force a fresh host output snapshot");
  assert.equal(host.previousWidth, 89);
  assert.equal(
    writes.some((chunk) => chunk.includes("[clearScreenDown]") || chunk.includes("\x1b[0J") || chunk.includes("\x1b[J") || chunk.includes("\x1b[2J\x1b[H")),
    true,
    "redraw should clear stale lower screen rows",
  );
}

function runOverViewportRedrawRegression() {
  const writes = [];
  const fakeOutput = {
    columns: 80,
    rows: 8,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  host.setInteractive(true);
  const component = host.append(new StaticLinesComponent("long", Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)));
  host.invalidate({ force: true });
  assert.equal(host.renderedLines.length > fakeOutput.rows, true, "normal-screen rendering should preserve scrollback instead of clipping to the viewport");

  const beforeSameRender = writes.length;
  host.invalidate({ force: true });
  assert.equal(writes.length, beforeSameRender, "unchanged interactive renders must not append duplicate snapshots");

  const beforeTailRender = writes.length;
  component.setLines(Array.from({ length: 41 }, (_, index) => `line ${index + 1}`));
  host.invalidate({ force: true });
  const tailWrite = writes.slice(beforeTailRender).join("");
  assert.match(tailWrite, /line 41/, "stream growth should render only the changed tail");
  assert.equal(tailWrite.includes("line 1"), false, "stream growth must not replay the full transcript");
}

function runInteractiveHostUsesNormalScreenRegression() {
  const writes = [];
  const fakeOutput = {
    columns: 80,
    rows: 20,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  host.setInteractive(true);
  host.append(new StaticLinesComponent("stream", ["Sure.", "The day arrives without asking,"]));
  host.invalidate({ force: true });
  host.dispose();
  const raw = writes.join("");

  assert.equal(raw.includes("\x1b[?1049h"), false, "interactive chat should not enter the alternate screen buffer");
  assert.equal(raw.includes("\x1b[?1049l"), false, "interactive chat should leave normal terminal scrollback selectable");
  assert.equal(raw.includes("\x1b[?1000h"), false, "interactive chat must not enable mouse tracking");
  assert.equal(raw.includes("\x1b[?1006h"), false, "interactive chat must not capture mouse selection");
}

function runPreInteractivePanelsSurviveInteractiveRegression() {
  let plain = "";
  let raw = "";
  captureStdout(() => {
    const ui = createZyraUi();
    ui.banner({
      project: "C:\\Users\\elson\\my_coding_play\\playground\\Cara's agent",
      model: "openai-codex/gpt-5.5",
      profile: "elson",
      thinking: "medium",
      terminalTheme: "rose-pine",
      projectMemory: ["AGENTS.md"],
    });
    ui._debugBeginInteractiveForTests();
    const rendered = ui._debugRenderLinesForTests(90);
    raw = rendered.join("\n");
    plain = rendered.map(stripAnsi).join("\n");
  });

  assert.match(plain, /┏━━━┳┓/);
  assert.match(plain, /gpt-5\.5 · elson/);
  assert.match(raw, /\x1b\[38;2;196;167;231m\[Context\]/);
  assert.match(plain, /\[Context\]/);
  assert.match(plain, /AGENTS\.md/);
  assert.match(plain, /\[Runtime\]/);
  assert.match(plain, /openai-codex\/gpt-5\.5 · medium/);
  assert.match(plain, /\[Theme\]/);
  assert.match(plain, /rose-pine/);
  assert.equal(plain.includes("✦ Cara"), false, "startup banner should use the Zyra wordmark");
  assert.equal(plain.includes("to orient"), false, "startup banner should stay compact and not print command hints");
}

function runStartupSectionLabelsUseActiveThemeRegression() {
  let raw = "";
  captureStdout(() => {
    const ui = createZyraUi({
      terminalTheme: {
        name: "pill-test",
        colors: {
          accent: "#12ab34",
          info: "#abcdef",
        },
      },
    });
    ui.banner({
      project: "C:\\Users\\elson\\my_coding_play\\playground\\Cara's agent",
      model: "openai-codex/gpt-5.5",
      profile: "elson",
      thinking: "medium",
      terminalTheme: "pill-test",
      projectMemory: ["AGENTS.md"],
    });
    raw = ui._debugRenderLinesForTests(90).join("\n");
  });

  assert.match(raw, /\x1b\[38;2;18;171;52m\[Context\]/);
  assert.match(raw, /\x1b\[38;2;18;171;52m\[Runtime\]/);
  assert.match(raw, /\x1b\[38;2;18;171;52m\[Theme\]/);
}

function runInteractiveSessionResetRedrawRegression() {
  const writes = [];
  const fakeOutput = {
    columns: 80,
    rows: 18,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  host.setInteractive(true);
  host.append(new StaticLinesComponent("old", ["old transcript"]));
  host.setInputComponent(new StaticLinesComponent("input", ["> input"]));
  host.invalidate({ force: true });

  const beforeReset = writes.length;
  host.replaceComponents([new StaticLinesComponent("new", ["new banner"])], { clear: true });
  const resetWrite = writes.slice(beforeReset).join("");
  const plain = host.renderLines(79).map(stripAnsi).join("\n");

  assert.match(resetWrite, /\x1b\[2J\x1b\[H\x1b\[3J/, "session reset should clear the visible screen and scrollback");
  assert.equal(plain.includes("old transcript"), false, "session reset should drop old transcript components");
  assert.equal(plain.includes("new banner"), true, "session reset should render fresh session content");
  assert.equal(plain.includes("> input"), true, "session reset should keep the input component alive");
}

function runTranscriptScrollKeepsInputPinnedRegression() {
  const fakeOutput = {
    columns: 80,
    rows: 10,
    write() {
      return true;
    },
    on() {},
    off() {},
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  host.setInteractive(true);
  host.append(new StaticLinesComponent("content", Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)));
  host.setInputComponent(new StaticLinesComponent("input", ["> input", "", "status"]));

  const lines = host.renderLines(79).map(stripAnsi);
  assert.equal(lines.some((line) => line.includes("line 1")), true);
  assert.equal(lines.some((line) => line.includes("line 30")), true);
  assert.equal(lines.at(-3), "> input");
  assert.equal(lines.at(-1), "status");
  assert.equal(host.scrollBy(8), false, "normal terminal scrollback should handle scroll without app-owned mouse capture");
}

function runEditorStatusGapRegression() {
  const editor = new EditorComponent({
    statusLine: () => "STATUS",
    suggestions: () => [],
    theme: {},
  });
  const lines = editor.render(80).map(stripAnsi);
  assert.equal(lines[0], "─".repeat(80), "editor should draw an input rail above the prompt");
  assert.equal(lines[2], "─".repeat(80), "editor should draw an input rail below the prompt");
  assert.equal(lines.at(-2), "", "editor should leave one empty line between input and status line");
  assert.equal(lines.at(-1), "STATUS");
}

function runEditorBusySpacingRegression() {
  const editor = new EditorComponent({
    getBusy: () => true,
    getActivityLabel: () => "thinking",
    suggestions: () => [],
    theme: {},
  });
  editor.hasTranscript = true;

  const lines = editor.render(80).map(stripAnsi);
  const activityIndex = lines.findIndex((line) => line.includes("thinking"));
  assert.ok(activityIndex > 0, "busy activity line should render after transcript spacing");
  assert.equal(lines[activityIndex - 1], "", "busy activity line should have breathing room above");
  assert.equal(lines[activityIndex + 1], "", "busy activity line should have breathing room below");
}

function runEditorSessionResetRegression() {
  const editor = new EditorComponent({
    suggestions: () => [],
    theme: {},
  });
  editor.buffer = "/new";
  editor.hasTranscript = true;
  editor.waiting = true;
  editor.starterRecommendationDismissed = true;

  editor.resetSession();

  assert.equal(editor.buffer, "");
  assert.equal(editor.hasTranscript, false);
  assert.equal(editor.waiting, false);
  assert.equal(editor.starterRecommendationDismissed, false);
}

function runEditorImmediateSlashRegression() {
  const invalidations = [];
  const editor = new EditorComponent({
    suggestions: (text) => text === "/" ? [{ value: "/commands", label: "/commands", description: "show controls", kind: "command" }] : [],
    theme: {},
  });
  editor.setHost({
    invalidate: (options = {}) => invalidations.push(options),
  });

  editor.handleKeypress("/", {});
  assert.equal(editor.buffer, "/", "single-character input should flush immediately");
  assert.equal(invalidations.at(-1)?.fixedOnly, true, "typing should redraw fixed input lines without dirtying transcript content");
  assert.match(editor.render(80).map(stripAnsi).join("\n"), /\/commands/, "slash suggestions should activate on the slash keypress");
  editor.dispose();
}

function runThemeSelectorStartsOnActiveThemeRegression() {
  const editor = new EditorComponent({
    suggestions: () => [
      { value: "dusk", label: "dusk", description: "theme", kind: "theme" },
      { value: "quiet", label: "quiet", description: "active", kind: "theme", selected: true },
      { value: "vivid", label: "vivid", description: "theme", kind: "theme" },
    ],
    theme: {},
  });

  editor.buffer = "/themes ";
  editor.render(80);
  assert.equal(editor.selectedIndex, 1, "theme selector should start on the active theme");

  editor.handleKeypress("", { name: "down" });
  editor.render(80);
  assert.equal(editor.selectedIndex, 2, "manual theme navigation should not snap back to the active theme");
  editor.dispose();
}

function runFixedOnlyInputRenderAvoidsTranscriptReplayRegression() {
  const writes = [];
  const fakeOutput = {
    columns: 80,
    rows: 16,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
  };
  const host = new ZyraComponentHost({ output: fakeOutput, autoRender: true });
  const editor = new EditorComponent({
    suggestions: () => [],
    statusLine: () => "STATUS",
    theme: {},
  });

  host.setInteractive(true);
  host.append(new StaticLinesComponent("transcript", Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)));
  host.setInputComponent(editor);
  host.invalidate({ force: true });
  writes.length = 0;

  editor.buffer = "a";
  host.invalidate({ fixedOnly: true, force: true });
  const raw = writes.join("");

  assert.match(stripAnsi(raw), /> a/, "fixed input render should update the typed buffer");
  assert.equal(raw.includes("line 1"), false, "fixed input render must not replay transcript content");
  editor.dispose();
}

function runStatusLineColorRegression() {
  const runtime = {
    profile: "elson",
    terminalTheme: {
      name: "status-test",
      colors: {
        primary: "#ff0000",
        warning: "#ffff00",
        muted: "#777777",
        accent: "#ff00ff",
        info: "#00ffff",
        success: "#00ff00",
        error: "#ff5555",
      },
    },
    session: {
      model: { id: "gpt-test" },
      thinkingLevel: "medium",
      getContextUsage: () => ({ percent: 72 }),
      sessionManager: {
        getCwd: () => "C:\\Users\\elson\\project",
        getEntries: () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.3 } } } }],
      },
      modelRegistry: {
        isUsingOAuth: () => false,
      },
    },
  };
  const line = renderStatusLine(runtime, 120);

  assert.match(line, /\x1b\[38;2;255;0;0m gpt-test/);
  assert.match(line, /\x1b\[38;2;255;255;0m medium/);
  assert.match(line, /\x1b\[38;5;75melson/);
  assert.match(line, /\x1b\[38;2;255;255;0mContext 28% left/);
  assert.match(line, /\x1b\[38;5;82m\$0\.300/);

  runtime.session.getContextUsage = () => undefined;
  runtime.session.sessionManager.getEntries = () => [];
  const freshLine = renderStatusLine(runtime, 120);
  assert.match(freshLine, /\x1b\[38;2;0;255;0mContext 100% left/);
  assert.match(freshLine, /\x1b\[38;2;119;119;119m\$0\.000/);
}

function runStatusLineCostCacheRegression() {
  let iterations = 0;
  const entries = [
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
  ];
  entries[Symbol.iterator] = function* iterator() {
    iterations += 1;
    yield entries[0];
  };
  const runtime = {
    profile: "elson",
    terminalTheme: "quiet",
    session: {
      model: { provider: "openai-codex", id: "gpt-test" },
      thinkingLevel: "medium",
      getContextUsage: () => ({ percent: 10 }),
      sessionManager: {
        getCwd: () => process.cwd(),
        getEntries: () => entries,
      },
      modelRegistry: {
        isUsingOAuth: () => true,
      },
    },
  };

  renderStatusLine(runtime, 120);
  renderStatusLine(runtime, 120);
  assert.equal(iterations, 1, "status line should not rescan message cost on every input render");
}

function runSystemPanelWidthRegression() {
  const widthOf = (lines) => stripAnsi(lines.find((line) => stripAnsi(line).trim()) ?? "").length;
  const account = {
    provider: "openai-codex",
    status: { configured: true, source: "test" },
    email: "elson@example.com",
    plan: "plus",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const usage = {
    source: "test",
    plan: "plus",
    account: "elson@example.com",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };

  for (const terminalColumns of [80, 120]) {
    const statusWidth = widthOf(renderStatusBox({}, undefined, terminalColumns));
    assert.equal(widthOf(renderAccountStatusBox(account, undefined, terminalColumns)), statusWidth);
    assert.equal(widthOf(renderCodexUsageBox(usage, undefined, terminalColumns)), statusWidth);
  }
}

function runThemePreferencePersistenceRegression() {
  const project = mkdtempSync(path.join(os.tmpdir(), "zyra-theme-"));
  try {
    const entries = [];
    const runtime = {
      project,
      session: {
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
          appendCustomEntry: (customType, data) => entries.push({ customType, data }),
        },
      },
    };

    setZyraTheme(runtime, "quiet");
    const preferences = JSON.parse(readFileSync(path.join(project, ".zyra", "preferences.json"), "utf8"));

    assert.equal(preferences.terminalTheme, "quiet");
    assert.equal(runtime.terminalTheme.name, "quiet");
    assert.equal(entries.at(-1)?.data?.name, "quiet");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function runSessionCommandRenameRegression() {
  const values = getSlashSuggestions({ project: process.cwd(), session: {} }, "/").map((item) => item.value);
  assert.equal(values.includes("/session"), true);
  assert.equal(values.includes("/chat"), true);
  assert.equal(values.includes("/status"), false);
}

runDeltaStreamingRegression();
runFullSnapshotRegression();
runRepeatedSnapshotRegression();
runMarkdownCodeBlockRegression();
runMergeHelperRegression();
runSnapshotDeltaPollutionRegression();
runUiEventCaptureRegression();
runToolOutputStyleRegression();
runToolCallThemeStylingRegression();
runInteractiveAssistantComponentRegression();
runInteractiveNoTurnEndDuplicateRegression();
runInteractiveToolComponentRegression();
runRunningToolStartsImmediatelyRegression();
runWriteToolRicherRepresentationRegression();
runConsecutiveToolSpacingRegression();
runAssistantAndToolInterleaveRegression();
runWidthFitRegression();
runStaticPanelsThroughHostRegression();
runResizeFullRedrawRegression();
runOverViewportRedrawRegression();
runInteractiveHostUsesNormalScreenRegression();
runPreInteractivePanelsSurviveInteractiveRegression();
runStartupSectionLabelsUseActiveThemeRegression();
runInteractiveSessionResetRedrawRegression();
runTranscriptScrollKeepsInputPinnedRegression();
runEditorStatusGapRegression();
runEditorBusySpacingRegression();
runEditorSessionResetRegression();
runEditorImmediateSlashRegression();
runThemeSelectorStartsOnActiveThemeRegression();
runFixedOnlyInputRenderAvoidsTranscriptReplayRegression();
runStatusLineColorRegression();
runStatusLineCostCacheRegression();
runSystemPanelWidthRegression();
runThemePreferencePersistenceRegression();
runSessionCommandRenameRegression();
console.log("zyra-ui render regression: ok");
