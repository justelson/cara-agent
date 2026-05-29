import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildTerminalTheme } from "./terminal-theme.mjs";

const sep = " \u00b7 ";
const reset = "\x1b[0m";
const dim = "\x1b[2m";
const blue = "\x1b[38;5;75m";
const pink = "\x1b[38;5;213m";
const green1 = "\x1b[38;5;70m";
const green2 = "\x1b[38;5;76m";
const green3 = "\x1b[38;5;82m";
const green4 = "\x1b[38;5;46m";
const branchCache = new Map();
const branchCacheMs = 4000;
const costCache = new WeakMap();

export function renderStatusLine(runtime, width = Math.max(24, (process.stdout.columns ?? 100) - 1), state = {}) {
  const session = runtime.session;
  const model = session.model;
  const modelLabel = model?.id ?? "no-model";
  const thinking = session.thinkingLevel ?? "off";
  const profile = runtime.profile ?? "auto";
  const activity = String(state.activity ?? "").trim();
  const context = formatContext(session);
  const cwdPath = session.sessionManager.getCwd();
  const cwd = formatPathWithBranch(cwdPath);
  const cost = formatCost(session);

  const maxWidth = Math.max(24, width);
  const theme = buildTerminalTheme(runtime.terminalTheme);
  const modelStatus = `${modelLabel} ${thinking}${sep}${profile}`;
  const leftPlain = activity ? ` ${modelStatus}${sep}${activity}` : ` ${modelStatus}`;
  const rightBudget = Math.max(8, maxWidth - visibleWidth(leftPlain) - 1);
  const rightPlain = buildRightStatus(context, cwd, cost, rightBudget);
  const gap = Math.max(1, maxWidth - visibleWidth(leftPlain) - visibleWidth(rightPlain));
  const plain = truncateToWidth(`${leftPlain}${" ".repeat(gap)}${rightPlain}`, maxWidth, "...");

  // If the terminal gets very narrow, avoid fighting truncation with ANSI spans.
  if (plain.length < leftPlain.length + rightPlain.length) {
    return low(theme.muted, plain);
  }

  const right = buildRightStatusParts(context, cwd, cost, rightBudget);
  const left = [
    color(theme.primary, ` ${modelLabel}`),
    color(theme.warning, ` ${thinking}`),
    low(theme.muted, sep),
    color(profileColor(theme, profile), profile),
    activity ? low(theme.muted, sep) : "",
    activity ? color(theme.info, activity) : "",
  ].join("");

  const rightColored = right.cwd
    ? [
        color(contextColor(theme, session), right.context),
        low(theme.muted, sep),
        low(theme.muted, right.cwd),
        low(theme.muted, sep),
        color(costColor(theme, right.cost), right.cost),
      ].join("")
    : [color(contextColor(theme, session), right.context), low(theme.muted, sep), color(costColor(theme, right.cost), right.cost)].join("");

  return [left, " ".repeat(gap), rightColored, reset].join("");
}

function buildRightStatus(context, cwd, cost, width) {
  const right = buildRightStatusParts(context, cwd, cost, width);
  return right.cwd ? `${right.context}${sep}${right.cwd}${sep}${right.cost}` : `${right.context}${sep}${right.cost}`;
}

function buildRightStatusParts(context, cwd, cost, width) {
  const fixed = `${context}${sep}${sep}${cost}`;
  const pathWidth = Math.max(0, width - fixed.length);
  if (pathWidth <= 3) {
    return { context: truncateToWidth(context, Math.max(0, width - cost.length - sep.length), "..."), cwd: "", cost };
  }
  return { context, cwd: truncateToWidth(cwd, pathWidth, "..."), cost };
}

function formatContext(session) {
  const usage = session.getContextUsage?.();
  const percent = usage?.percent;
  if (percent === null) return "Context ? left";
  if (typeof percent !== "number") return "Context 100% left";

  const left = Math.max(0, 100 - percent);
  const value = left >= 10 ? left.toFixed(0) : left.toFixed(1);
  return `Context ${value}% left`;
}

function formatCost(session) {
  const manager = session.sessionManager;
  const entries = manager.getEntries();
  const modelKey = session.model ? `${session.model.provider ?? ""}/${session.model.id ?? ""}` : "";
  const cached = costCache.get(manager);
  const lastEntry = entries.at(-1);
  const lastCost = lastEntry?.message?.usage?.cost?.total;
  if (cached && cached.length === entries.length && cached.lastEntry === lastEntry && cached.lastCost === lastCost && cached.modelKey === modelKey) {
    return cached.value;
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    total += entry.message.usage?.cost?.total ?? 0;
  }

  const subscription = session.model ? session.modelRegistry.isUsingOAuth(session.model) : false;
  const value = `$${total.toFixed(3)}${subscription ? " sub" : ""}`;
  costCache.set(manager, { length: entries.length, lastEntry, lastCost, modelKey, value });
  return value;
}

function formatPath(cwd) {
  const home = os.homedir();
  let display = cwd;
  if (home && cwd.toLowerCase().startsWith(home.toLowerCase())) {
    display = `~${cwd.slice(home.length)}`;
  }

  return display.split(path.sep).join("\\");
}

function formatPathWithBranch(cwd) {
  const display = formatPath(cwd);
  const branch = getGitBranch(cwd);
  return branch ? `${display} [${branch}]` : display;
}

function getGitBranch(cwd) {
  if (!cwd) return "";
  const key = path.resolve(cwd).toLowerCase();
  const cached = branchCache.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < branchCacheMs) {
    return cached.branch;
  }

  if (!cached?.inFlight) {
    const branch = cached?.branch ?? "";
    branchCache.set(key, { branch, checkedAt: cached?.checkedAt ?? 0, inFlight: true });
    refreshGitBranch(cwd, key, branch);
  }
  return cached?.branch ?? "";
}

async function refreshGitBranch(cwd, key, previousBranch = "") {
  try {
    const branch = await readGitBranch(cwd);
    branchCache.set(key, { branch, checkedAt: Date.now(), inFlight: false });
  } catch {
    branchCache.set(key, { branch: previousBranch, checkedAt: Date.now(), inFlight: false });
  }
}

async function readGitBranch(cwd) {
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  if (branch) return branch;

  const ref = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (ref && ref !== "HEAD") return ref;

  const commit = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return commit ? `detached:${commit}` : "";
}

function contextColor(theme, session) {
  const percent = session.getContextUsage?.()?.percent;
  if (percent === null) return theme.warning || theme.muted;
  if (typeof percent !== "number") return theme.success || theme.muted;
  if (percent >= 85) return theme.error;
  if (percent >= 65) return theme.warning;
  return theme.success;
}

function profileColor(theme, profile) {
  const value = String(profile ?? "").toLowerCase();
  if (value === "elson") return blue;
  if (value === "cara") return pink;
  return theme.accent;
}

function costColor(theme, cost) {
  const value = Number(String(cost ?? "").match(/\$([0-9.]+)/)?.[1] ?? 0);
  if (value >= 1) return green4;
  if (value >= 0.25) return green3;
  if (value >= 0.05) return green2;
  if (value > 0) return green1;
  return theme.muted;
}

function color(style, text) {
  if (!text) return "";
  return `${style ?? ""}${text}${reset}`;
}

function low(style, text) {
  if (!text) return "";
  return `${dim}${style ?? ""}${text}${reset}`;
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(String(value ?? "").trim());
    };
    const timeout = setTimeout(() => {
      child.kill();
      done("");
    }, 700);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => done(""));
    child.once("close", (code) => done(code === 0 ? stdout : ""));
  });
}

function visibleWidth(value) {
  return stripAnsi(String(value ?? "")).length;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
