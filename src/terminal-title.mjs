import path from "node:path";

const MAX_TITLE_CHARS = 160;
const PULSE_INTERVAL_MS = 1400;
const busyStates = new Set(["starting", "thinking", "working", "retrying", "compacting", "reloading"]);
const staticIcons = new Map([
  ["starting", "•"],
  ["thinking", "•"],
  ["working", "•"],
  ["retrying", "!"],
  ["compacting", "•"],
  ["reloading", "•"],
  ["waiting", "…"],
  ["stopped", "×"],
  ["error", "!"],
]);

let lastWrittenTitle = undefined;

export function createZyraTerminalTitle(options = {}) {
  const enabled = options.enabled ?? isInteractiveTerminal();
  let runtime = options.runtime;
  let project = options.project;
  let state = options.state ?? "ready";
  let pulse = 0;
  let pulseTimer = undefined;
  let disposed = false;
  let turnActive = false;
  let runningTools = 0;
  let terminalFocused = true;

  const write = () => {
    if (!enabled || disposed) return;
    const title = buildZyraTerminalTitle({
      icon: iconForState(state, pulse),
      project: resolveProjectName(runtime, project),
    });
    setTerminalTitle(title);
  };

  const syncPulse = () => {
    if (!enabled || disposed || !busyStates.has(state)) {
      if (pulseTimer) clearInterval(pulseTimer);
      pulseTimer = undefined;
      pulse = 0;
      return;
    }
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      pulse = pulse === 0 ? 1 : 0;
      write();
    }, options.pulseMs ?? PULSE_INTERVAL_MS);
    pulseTimer.unref?.();
  };

  const update = (next = {}) => {
    if (next.runtime) runtime = next.runtime;
    if (next.project) project = next.project;
    if (next.state) {
      state = normalizeState(next.state);
      pulse = 0;
      if (state === "ready" || state === "stopped" || state === "error") {
        turnActive = false;
        runningTools = 0;
      }
    }
    write();
    syncPulse();
  };

  update({ state, runtime, project });

  return {
    update,
    setFocused(focused) {
      terminalFocused = Boolean(focused);
    },
    notifyWhenUnfocused() {
      if (!enabled || disposed || terminalFocused) return false;
      process.stdout.write("\x07");
      return true;
    },
    notify(mode = "unfocused") {
      const normalized = String(mode ?? "unfocused").trim().toLowerCase();
      if (!enabled || disposed || normalized === "off") return false;
      if (normalized !== "always" && terminalFocused) return false;
      process.stdout.write("\x07");
      return true;
    },
    fromEvent(event, nextRuntime = runtime) {
      const next = stateFromEvent(event, {
        turnActive,
        runningTools,
        setTurnActive: (value) => {
          turnActive = value;
        },
        setRunningTools: (value) => {
          runningTools = Math.max(0, value);
        },
      });
      if (next) update({ state: next, runtime: nextRuntime });
      else update({ runtime: nextRuntime });
    },
    dispose(options = {}) {
      disposed = true;
      if (pulseTimer) clearInterval(pulseTimer);
      pulseTimer = undefined;
      if (options.clear !== false) clearTerminalTitle();
    },
  };
}

export function buildZyraTerminalTitle({ icon = "", project = "" } = {}) {
  const parts = [icon, "Zyra"].filter(Boolean);
  const left = parts.join(" ");
  return sanitizeTerminalTitle(project ? `${left} · ${project}` : left);
}

export function setTerminalTitle(title) {
  if (!isInteractiveTerminal()) return false;
  const next = sanitizeTerminalTitle(title);
  if (!next || next === lastWrittenTitle) return false;
  process.stdout.write(`\x1b]0;${next}\x07`);
  lastWrittenTitle = next;
  return true;
}

export function clearTerminalTitle() {
  if (!isInteractiveTerminal()) return false;
  process.stdout.write("\x1b]0;\x07");
  lastWrittenTitle = undefined;
  return true;
}

function stateFromEvent(event = {}, activity = {}) {
  if (event.type === "turn_start") {
    activity.setTurnActive?.(true);
    activity.setRunningTools?.(0);
    return "thinking";
  }
  if (event.type === "message_start" || event.type === "message_update") {
    return activity.runningTools > 0 ? "working" : "thinking";
  }
  if (event.type === "tool_execution_start") {
    activity.setRunningTools?.(activity.runningTools + 1);
    return "working";
  }
  if (event.type === "tool_execution_update") return "working";
  if (event.type === "tool_execution_end") {
    const nextTools = Math.max(0, activity.runningTools - 1);
    activity.setRunningTools?.(nextTools);
    if (nextTools > 0) return "working";
    return activity.turnActive ? "thinking" : "ready";
  }
  if (event.type === "auto_retry_start") return "retrying";
  if (event.type === "compaction_start") return "compacting";
  if (event.type === "turn_end" || event.type === "agent_end") {
    activity.setTurnActive?.(false);
    activity.setRunningTools?.(0);
    return "ready";
  }
  return "";
}

function iconForState(state, pulse = 0) {
  if (busyStates.has(state) && state !== "retrying") return pulse === 0 ? "•" : "∙";
  return staticIcons.get(state) ?? "";
}

function normalizeState(state) {
  const value = String(state ?? "").trim().toLowerCase();
  if (busyStates.has(value) || value === "ready" || staticIcons.has(value)) return value;
  return "ready";
}

function resolveProjectName(runtime, fallbackProject) {
  const cwd = runtime?.session?.sessionManager?.getCwd?.() ?? runtime?.project ?? fallbackProject ?? process.cwd();
  const normalized = String(cwd ?? "").replace(/[\\\/]+$/, "");
  const name = path.basename(normalized);
  return name || normalized || "project";
}

function sanitizeTerminalTitle(title) {
  let value = String(title ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if ([...value].length > MAX_TITLE_CHARS) {
    value = [...value].slice(0, MAX_TITLE_CHARS).join("").trim();
  }
  return value;
}

function isInteractiveTerminal() {
  return Boolean(process.stdout?.isTTY);
}
