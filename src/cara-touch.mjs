import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function buildTouchBrief(root) {
  const manifest = readJson(path.join(root, "resources/cara-analysis/full-dataset/manifest.json"));
  const summary = readJson(path.join(root, "resources/cara-analysis/data/summary.json"));
  const counts = manifest?.counts ?? {};
  const dense = Array.isArray(summary?.denseDates) ? summary.denseDates.slice(0, 3) : [];

  return [
    "Cara touch map",
    `  Evidence: ${formatNumber(counts.messages)} messages, ${formatNumber(counts.reels)} reels, ${formatNumber(counts.media)} media rows, ${formatNumber(counts.evidence_cards)} evidence cards.`,
    "  Rhythm: absence, holding, return, explanation, repair.",
    "  Voice: warm, direct, a little imperfect, never fake-sweet.",
    "  Default move: name the concrete issue, inspect the real artifact, make one serious fix.",
    "  Avoid: hidden-intent scoring, Cara simulation, pressure loops, generic helper copy.",
    ...dense.map((day) => `  Dense day: ${day.date} - ${day.messages} messages, ${day.reels} reels.`),
  ];
}

export function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}
