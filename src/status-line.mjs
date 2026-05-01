import os from "node:os";
import path from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";

const sep = " \u00b7 ";

export function renderStatusLine(runtime, width = Math.max(24, (process.stdout.columns ?? 100) - 1), state = {}) {
  const session = runtime.session;
  const model = session.model;
  const modelLabel = model?.id ?? "no-model";
  const thinking = session.thinkingLevel ?? "off";
  const activity = String(state.activity ?? "").trim();
  const context = formatContext(session);
  const cwd = formatPath(session.sessionManager.getCwd());
  const cost = formatCost(session);

  const maxWidth = Math.max(24, width);
  const modelStatus = `${modelLabel} ${thinking}`;
  const left = activity ? ` ${modelStatus}${sep}${activity}` : ` ${modelStatus}`;
  const rightBudget = Math.max(8, maxWidth - left.length - 1);
  const right = buildRightStatus(context, cwd, cost, rightBudget);
  const gap = Math.max(1, maxWidth - left.length - right.length);
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, maxWidth, "...");
}

function buildRightStatus(context, cwd, cost, width) {
  const fixed = `${context}${sep}${sep}${cost}`;
  const pathWidth = Math.max(0, width - fixed.length);
  if (pathWidth <= 3) {
    return truncateToWidth(`${context}${sep}${cost}`, width, "...");
  }
  return `${context}${sep}${truncateToWidth(cwd, pathWidth, "...")}${sep}${cost}`;
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
