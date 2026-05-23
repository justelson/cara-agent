import readline from "node:readline";
import { stdin as input } from "node:process";
import { EditorComponent } from "./tui/components/editor.mjs";

const busyAnimationMs = 120;

export async function runTerminalInputLoop(onInput, options = {}, controls = {}) {
  if (!input.isTTY || !controls.host) {
    await readPipe(onInput);
    return;
  }

  const host = controls.host;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let cleanedUp = false;
  let resizeRenderTimer = undefined;
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const editor = new EditorComponent({
    ...options,
    theme: options.theme,
    getBusy: controls.getBusy,
    getActivityLabel: controls.getActivityLabel,
    suppressWorking: controls.suppressWorking,
    onSubmit: onInput,
    onUserMessage: controls.onUserMessage,
    onExit(status = 0) {
      cleanup();
      if (status === 130) process.exit(130);
    },
  });

  const scheduleResizeRender = () => {
    if (cleanedUp) return;
    if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
    resizeRenderTimer = setTimeout(() => {
      resizeRenderTimer = undefined;
      host.invalidate({ force: true });
    }, 24);
  };

  const onKeypress = async (str, key) => {
    try {
      await editor.handleKeypress(str, key);
    } catch (error) {
      controls.onError?.(error);
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    input.off("keypress", onKeypress);
    if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
    outputOffResize(host, scheduleResizeRender);
    process.off?.("SIGWINCH", scheduleResizeRender);
    clearInterval(animation);
    editor.dispose();
    input.setRawMode(false);
    input.pause();
    controls.clearRenderers?.();
    host.dispose();
    host.setInputComponent(null);
    finish();
  };

  host.setInteractive(true);
  host.setInputComponent(editor);
  controls.setRenderers?.(() => host.invalidate({ force: true }), () => host.clearRendered());
  host.output.on?.("resize", scheduleResizeRender);
  process.on?.("SIGWINCH", scheduleResizeRender);
  input.on("keypress", onKeypress);

  const animation = setInterval(() => {
    if (cleanedUp) return;
    if (editor.waiting || controls.getBusy?.()) editor.tickBusy();
  }, busyAnimationMs);

  host.invalidate({ force: true });
  await done;
}

function outputOffResize(host, handler) {
  host?.output?.off?.("resize", handler);
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
