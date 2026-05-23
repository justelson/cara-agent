#!/usr/bin/env node
import assert from "node:assert/strict";
import { AssistantMessageLifecycle, createZyraUi, mergeAssistantTextDelta } from "../src/zyra-ui.mjs";
import { renderStatusLine } from "../src/status-line.mjs";
import { renderAccountStatusBox, renderCodexUsageBox, renderStatusBox } from "../src/terminal-blocks.mjs";
import { ZyraComponentHost, EditorComponent, StaticLinesComponent } from "../src/tui/zyra-tui.mjs";
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
  assert.match(captured, /bash succeeded/);
  assert.match(captured, /git remote -v/);
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
  assert.match(plain, /Zyra status/);
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
  assert.match(raw, /\x1b\[38;2;49;116;143m\[Context\]/);
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
          info: "#12ab34",
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

function runStatusLineColorRegression() {
  const runtime = {
    profile: "elson",
    terminalTheme: {
      primary: "\x1b[31m",
      warning: "\x1b[33m",
      muted: "\x1b[90m",
      accent: "\x1b[35m",
      info: "\x1b[36m",
      success: "\x1b[32m",
      error: "\x1b[91m",
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

  assert.match(line, /\x1b\[31m gpt-test/);
  assert.match(line, /\x1b\[33m medium/);
  assert.match(line, /\x1b\[38;5;75melson/);
  assert.match(line, /\x1b\[33mContext 28% left/);
  assert.match(line, /\x1b\[38;5;82m\$0\.300/);
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

runDeltaStreamingRegression();
runFullSnapshotRegression();
runRepeatedSnapshotRegression();
runMarkdownCodeBlockRegression();
runMergeHelperRegression();
runSnapshotDeltaPollutionRegression();
runUiEventCaptureRegression();
runToolOutputStyleRegression();
runInteractiveAssistantComponentRegression();
runInteractiveNoTurnEndDuplicateRegression();
runInteractiveToolComponentRegression();
runAssistantAndToolInterleaveRegression();
runWidthFitRegression();
runStaticPanelsThroughHostRegression();
runResizeFullRedrawRegression();
runOverViewportRedrawRegression();
runInteractiveHostUsesNormalScreenRegression();
runPreInteractivePanelsSurviveInteractiveRegression();
runStartupSectionLabelsUseActiveThemeRegression();
runTranscriptScrollKeepsInputPinnedRegression();
runEditorStatusGapRegression();
runEditorBusySpacingRegression();
runStatusLineColorRegression();
runSystemPanelWidthRegression();
console.log("zyra-ui render regression: ok");
