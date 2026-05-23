import readline from "node:readline";
import { stdin as input } from "node:process";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { EditorComponent } from "./tui/components/editor.mjs";

const busyAnimationMs = 120;
const mouseTrackingStart = "\x1b[?1000h\x1b[?1006h";
const mouseTrackingEnd = "\x1b[?1006l\x1b[?1000l";

export async function runTerminalInputLoop(onInput, options = {}, controls = {}) {
  if (!input.isTTY || !controls.host) {
    await readPipe(onInput);
    return;
  }

  const host = controls.host;
  const keypressInput = new PassThrough();
  const rawInput = createTerminalInputRouter({
    writeKeypressData: (text) => keypressInput.write(text),
    onWheel: (direction) => {
      const rows = Math.max(3, Math.floor((host.height?.() ?? 24) / 6));
      host.scrollBy?.(direction * rows);
    },
  });
  readline.emitKeypressEvents(keypressInput);
  input.setRawMode(true);
  input.resume();
  host.output.write?.(mouseTrackingStart);

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
  const onData = (chunk) => rawInput.write(chunk);

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    input.off("data", onData);
    keypressInput.off("keypress", onKeypress);
    if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
    outputOffResize(host, scheduleResizeRender);
    process.off?.("SIGWINCH", scheduleResizeRender);
    clearInterval(animation);
    rawInput.end();
    keypressInput.destroy();
    editor.dispose();
    host.output.write?.(mouseTrackingEnd);
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
  keypressInput.on("keypress", onKeypress);
  input.on("data", onData);

  const animation = setInterval(() => {
    if (cleanedUp) return;
    if (editor.waiting || controls.getBusy?.()) editor.tickBusy();
  }, busyAnimationMs);

  host.invalidate({ force: true });
  await done;
}

export function createTerminalInputRouter(options = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  return {
    write(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      pending = routeTerminalInputText(pending, options);
    },
    end() {
      pending += decoder.end();
      if (pending) options.writeKeypressData?.(pending);
      pending = "";
    },
  };
}

export function routeTerminalInputText(text, options = {}) {
  const value = String(text ?? "");
  const mousePattern = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let cursor = 0;
  let match;

  while ((match = mousePattern.exec(value))) {
    if (match.index > cursor) options.writeKeypressData?.(value.slice(cursor, match.index));
    routeMouseButton(Number(match[1]), options.onWheel);
    cursor = mousePattern.lastIndex;
  }

  const tail = value.slice(cursor);
  const pendingMouseIndex = pendingMousePrefixIndex(tail);
  if (pendingMouseIndex >= 0) {
    if (pendingMouseIndex > 0) options.writeKeypressData?.(tail.slice(0, pendingMouseIndex));
    return tail.slice(pendingMouseIndex);
  }

  if (tail) options.writeKeypressData?.(tail);
  return "";
}

function routeMouseButton(button, onWheel) {
  if (!Number.isFinite(button) || (button & 64) !== 64) return;
  const directionCode = button & 3;
  if (directionCode === 0) onWheel?.(1);
  if (directionCode === 1) onWheel?.(-1);
}

function pendingMousePrefixIndex(value) {
  const index = value.lastIndexOf("\x1b[<");
  if (index < 0) return -1;
  const suffix = value.slice(index);
  return /^\x1b\[<\d*(?:;\d*){0,2}$/.test(suffix) ? index : -1;
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
