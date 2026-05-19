import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";

const sep = " \u00b7 ";
const reset = "\x1b[0m";
const dim = "\x1b[2m";
const branchCache = new Map();
const branchCacheMs = 4000;

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
  const theme = runtime.terminalTheme ?? {};
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
    low(theme.primary, ` ${modelLabel}`),
    low(theme.warning, ` ${thinking}`),
    low(theme.muted, sep),
    low(theme.accent, profile),
    activity ? low(theme.muted, sep) : "",
    activity ? low(theme.info, activity) : "",
  ].join("");

  const rightColored = right.cwd
    ? [
        low(contextColor(theme, session), right.context),
        low(theme.muted, sep),
        low(theme.muted, right.cwd),
        low(theme.muted, sep),
        low(theme.success, right.cost),
      ].join("")
    : [low(contextColor(theme, session), right.context), low(theme.muted, sep), low(theme.success, right.cost)].join("");

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
  let total = 0;
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    total += entry.message.usage?.cost?.total ?? 0;
  }

  const subscription = session.model ? session.modelRegistry.isUsingOAuth(session.model) : false;
  return `$${total.toFixed(3)}${subscription ? " sub" : ""}`;
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

  const branch = readGitBranch(cwd);
  branchCache.set(key, { branch, checkedAt: now });
  return branch;
}

function readGitBranch(cwd) {
  const branch = runGit(cwd, ["branch", "--show-current"]);
  if (branch) return branch;

  const ref = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (ref && ref !== "HEAD") return ref;

  const commit = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return commit ? `detached:${commit}` : "";
}

function contextColor(theme, session) {
  const percent = session.getContextUsage?.()?.percent;
  if (typeof percent !== "number") return theme.muted;
  if (percent >= 85) return theme.error;
  if (percent >= 65) return theme.warning;
  return theme.success;
}

function low(style, text) {
  if (!text) return "";
  return `${dim}${style ?? ""}${text}${reset}`;
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 700,
  });
  if (result.status !== 0) return "";
  return String(result.stdout ?? "").trim();
}

function visibleWidth(value) {
  return stripAnsi(String(value ?? "")).length;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
