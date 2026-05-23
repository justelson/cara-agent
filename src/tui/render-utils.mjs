export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const normalIntensity = "\x1b[22m";
export const fgReset = "\x1b[39m";
export const inverse = "\x1b[7m";
export const hideCursor = "\x1b[?25l";
export const showCursor = "\x1b[?25h";
export const syncStart = "\x1b[?2026h";
export const syncEnd = "\x1b[?2026l";
export const fakeCursor = "\x1b[7m \x1b[27m";

export function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function visibleWidth(text) {
  return stripAnsi(text).length;
}

export function terminalRenderWidth(output, subtract = 1) {
  return Math.max(24, Number(output?.columns ?? 100) - subtract);
}

export function terminalRenderHeight(output) {
  return Math.max(8, Number(output?.rows ?? 30));
}

export function physicalRowsForLine(line, width) {
  const liveWidth = Math.max(1, Number(width) || 1);
  return Math.max(1, Math.ceil(visibleWidth(line) / liveWidth));
}

export function countPhysicalRows(lines, width) {
  return (Array.isArray(lines) ? lines : []).reduce((total, line) => total + physicalRowsForLine(line, width), 0);
}

export function padToVisibleWidth(text, width) {
  const value = String(text ?? "");
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

export function truncatePlain(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  if (max <= 3) return ".".repeat(Math.max(1, max));
  return `${value.slice(0, max - 3)}...`;
}

export function truncateVisible(text, max) {
  const value = String(text ?? "");
  if (visibleWidth(value) <= max) return value;
  const plain = stripAnsi(value);
  return truncatePlain(plain, max);
}

export function clampLineToWidth(line, width) {
  return truncateVisible(line, Math.max(1, width));
}

export function wrapPlain(text, width) {
  const maxWidth = Math.max(1, width);
  const value = String(text ?? "");
  if (!value) return [""];
  const rows = [];

  for (const paragraph of value.split(/\r?\n/)) {
    const words = paragraph.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) {
      rows.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (stripAnsi(word).length > maxWidth) {
        if (current) {
          rows.push(current);
          current = "";
        }
        for (let index = 0; index < word.length; index += maxWidth) {
          rows.push(word.slice(index, index + maxWidth));
        }
        continue;
      }

      const next = current ? `${current} ${word}` : word;
      if (stripAnsi(next).length > maxWidth && current) {
        rows.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) rows.push(current);
  }

  return rows.length ? rows : [""];
}

export function trimOuterBlankLines(lines) {
  const normalized = (Array.isArray(lines) ? lines : []).map((line) => stripTrailingDisplayPadding(line));
  let start = 0;
  let end = normalized.length;
  while (start < end && stripAnsi(normalized[start]).trim().length === 0) start += 1;
  while (end > start && stripAnsi(normalized[end - 1]).trim().length === 0) end -= 1;
  return normalized.slice(start, end);
}

export function stripTrailingDisplayPadding(line) {
  return String(line ?? "").replace(/[ \t]+((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/g, "$1");
}

export function trimTrailingBlankEdges(lines) {
  let end = lines.length;
  while (end > 0 && stripAnsi(lines[end - 1]).trim().length === 0) end -= 1;
  return lines.slice(0, end);
}

export function splitDisplayLines(text) {
  return String(text ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export function renderLinesWithinWidth(lines, width) {
  return (Array.isArray(lines) ? lines : []).map((line) => clampLineToWidth(line, width));
}
