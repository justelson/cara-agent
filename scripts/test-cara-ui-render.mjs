#!/usr/bin/env node
import assert from "node:assert/strict";
import { AssistantMessageLifecycle, createCaraUi, mergeAssistantTextDelta } from "../src/cara-ui.mjs";
import { CaraComponentHost, StaticLinesComponent } from "../src/tui/cara-tui.mjs";
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
    "Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was.",
    "Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was. I found:",
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
    const ui = createCaraUi();
    ui.event({ type: "message_start", message: assistantMessage() });
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was."));
    ui.event({
      type: "message_end",
      message: assistantMessage("Yep. Here’s the useful recap:"),
    });
    assert.equal(getCaptured().includes("Yep"), false, "assistant text must not print before the turn boundary");
    ui.event({
      type: "message_end",
      message: assistantMessage("Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was."),
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
  assert.match(captured, /You asked where the original Cara project was/);
}

function runToolOutputStyleRegression() {
  const captured = captureStdout(() => {
    const ui = createCaraUi();
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
  const ui = createCaraUi();
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
  const ui = createCaraUi();
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
  const ui = createCaraUi();
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
  const ui = createCaraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "turn_start" });
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("Reading files..."));
  ui.event({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "tool-read",
    args: { path: "src/cara-ui.mjs" },
  });
  ui.event(updateEvent("Reading files...\n\nFound it."));
  ui.event({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "tool-read",
    args: { path: "src/cara-ui.mjs" },
    result: { content: [{ type: "text", text: "export function createCaraUi" }] },
  });
  const plain = ui._debugRenderLinesForTests(70).map(stripAnsi).join("\n");
  assert.equal((plain.match(/Reading files/g) ?? []).length, 1, "assistant stream should not become raw interleaved blocks");
  assert.equal((plain.match(/read/g) ?? []).length, 1, "tool output should stay in its keyed component");
}

function runWidthFitRegression() {
  const ui = createCaraUi();
  ui._debugBeginInteractiveForTests();
  ui.event({ type: "message_start", message: assistantMessage() });
  ui.event(updateEvent("A very long assistant line that should wrap or clamp without exceeding the requested render width."));
  ui.event({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "tool-width",
    args: { command: "node scripts/test-cara-ui-render.mjs --with-a-very-long-argument-that-needs-clamping" },
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
  const ui = createCaraUi();
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
  assert.match(plain, /Cara status/);
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
  const host = new CaraComponentHost({ output: fakeOutput, autoRender: true });
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
    writes.some((chunk) => chunk.includes("[clearScreenDown]") || chunk.includes("\x1b[0J") || chunk.includes("\x1b[J")),
    true,
    "redraw should clear stale lower screen rows",
  );
}

runDeltaStreamingRegression();
runFullSnapshotRegression();
runRepeatedSnapshotRegression();
runMarkdownCodeBlockRegression();
runMergeHelperRegression();
runUiEventCaptureRegression();
runToolOutputStyleRegression();
runInteractiveAssistantComponentRegression();
runInteractiveNoTurnEndDuplicateRegression();
runInteractiveToolComponentRegression();
runAssistantAndToolInterleaveRegression();
runWidthFitRegression();
runStaticPanelsThroughHostRegression();
runResizeFullRedrawRegression();
console.log("cara-ui render regression: ok");
