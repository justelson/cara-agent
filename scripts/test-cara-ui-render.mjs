#!/usr/bin/env node
import assert from "node:assert/strict";
import { AssistantMessageLifecycle, createCaraUi, mergeAssistantTextDelta } from "../src/cara-ui.mjs";

function assistantMessage(text = "") {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [] };
}

function updateEvent(text, delta) {
  return {
    type: "message_update",
    message: assistantMessage(text),
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

function runUiEventCaptureRegression() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk, encoding, callback) => {
    captured += String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };

  try {
    const ui = createCaraUi();
    ui.event({ type: "message_start", message: assistantMessage() });
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:"));
    ui.event(updateEvent("Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was."));
    ui.event({
      type: "message_end",
      message: assistantMessage("Yep. Here’s the useful recap:\n\nYou asked where the original Cara project was."),
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(
    (captured.match(/Yep/g) ?? []).length,
    1,
    `UI event path must commit the assistant answer once, not redraw snapshots into transcript. Captured:\n${captured}`,
  );
}

runDeltaStreamingRegression();
runFullSnapshotRegression();
runRepeatedSnapshotRegression();
runMarkdownCodeBlockRegression();
runMergeHelperRegression();
runUiEventCaptureRegression();
console.log("cara-ui render regression: ok");
