#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  getAssistantSnapshotDelta,
  mergeAssistantTextDelta,
  shouldRenderAssistantTransient,
} from "../src/cara-ui.mjs";

function run() {
  assert.equal(getAssistantSnapshotDelta("", "Yep. Here’s the useful recap:"), "Yep. Here’s the useful recap:");
  assert.equal(getAssistantSnapshotDelta("Yep.", "Yep. Here’s the useful recap:"), " Here’s the useful recap:");
  assert.equal(getAssistantSnapshotDelta("Yep. Here’s the useful recap:", "Yep. Here’s the useful recap:"), "");

  assert.equal(mergeAssistantTextDelta("Yep.", " Yep again."), "Yep. Yep again.");
  assert.equal(mergeAssistantTextDelta("Yep.", "Yep."), "Yep.");
  assert.equal(mergeAssistantTextDelta("Yep.", "Yep. Here"), "Yep. Here");

  assert.equal(
    shouldRenderAssistantTransient({
      assistantOpen: true,
      content: { text: "Yep. Here’s the useful recap:" },
      directAssistantText: "Yep. Here’s the useful recap:",
    }),
    false,
    "already-committed streamed assistant text must not be redrawn as transient UI",
  );

  assert.equal(
    shouldRenderAssistantTransient({
      assistantOpen: true,
      content: { text: "Tool-free snapshot text" },
      directAssistantText: "",
    }),
    true,
    "snapshot-only assistant text may render transiently until it is committed",
  );
}

run();
console.log("cara-ui render regression: ok");
