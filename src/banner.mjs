import { readFileSync } from "node:fs";

const reset = "\x1b[0m";
const fallbackMessages = ["hey anam cara"];
const fallbackPalette = {
  from: 109,
  hint: 245,
  art: [218, 224, 217, 181, 109],
};
const fallbackFont = {
  height: 6,
  spacing: 1,
  glyphs: {
    "?": ["██████╗ ", "╚════██╗", "  ███╔═╝", "  ╚══╝  ", "  ██╗   ", "  ╚═╝   "],
    " ": ["   ", "   ", "   ", "   ", "   ", "   "],
  },
};

const messages = loadJson("./banner-messages.json", { messages: fallbackMessages }).messages ?? fallbackMessages;
const messagePool = messages.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
const palettes = loadJson("./banner-palettes.json", { palettes: [fallbackPalette] }).palettes ?? [fallbackPalette];
const font = loadJson("./banner-font.json", fallbackFont);

export function pickOpeningTheme() {
  const message = pick(messagePool) ?? fallbackMessages[0];
  const palette = normalizePalette(pick(palettes));
  return { message, paletteName: palette.name, palette };
}

export function normalizeOpeningTheme(value) {
  const storedMessage = typeof value?.message === "string" ? value.message.trim() : "";
  const message = messagePool.includes(storedMessage) ? storedMessage : (pick(messagePool) ?? fallbackMessages[0]);
  const namedPalette =
    typeof value?.paletteName === "string"
      ? palettes.find((palette) => palette?.name === value.paletteName)
      : undefined;
  const palette = normalizePalette(value?.palette ?? namedPalette ?? pick(palettes));
  return { message, paletteName: palette.name, palette };
}

export function renderOpeningBanner(
  width = Math.max(32, (process.stdout.columns ?? 100) - 1),
  openingTheme = pickOpeningTheme(),
  terminalTheme,
) {
  const theme = normalizeOpeningTheme(openingTheme);
  const maxWidth = Math.max(24, width);
  const displayMessage = chooseDisplayMessage(theme.message.toLowerCase(), maxWidth);
  const artRows = renderTextArt(displayMessage, maxWidth);

  if (terminalTheme) {
    return [
      ...styleArtRows(artRows, [terminalTheme.primary, terminalTheme.accent, terminalTheme.success, terminalTheme.warning]),
      "",
      `${terminalTheme.primary}type${reset} ${terminalTheme.muted}/ to open menu${reset}`,
    ];
  }

  return [
    ...colorArtRows(artRows, theme.palette.art),
    "",
    `${color("type", theme.palette.art[0])} ${color("/ to open menu", theme.palette.hint)}`,
  ];
}

function chooseDisplayMessage(message, maxWidth) {
  const maxRows = (Number(font.height) || 6) * 2;
  if (renderTextArt(message, maxWidth).length <= maxRows) return message;
  const fitting = messagePool
    .map((value) => value.toLowerCase())
    .filter((value) => renderTextArt(value, maxWidth).length <= maxRows);
  return pick(fitting) ?? message;
}

function renderTextArt(text, maxWidth) {
  const wrappedLines = wrapWords(text, maxWidth);
  const rows = [];

  for (const line of wrappedLines) {
    rows.push(...renderArtLine(line));
  }

  return rows.filter((row) => row.trim().length > 0);
}

function renderArtLine(text) {
  const height = Number(font.height) || 5;
  const rows = Array.from({ length: height }, () => "");
  const spacing = " ".repeat(Math.max(0, Number(font.spacing) || 0));

  for (const character of Array.from(text)) {
    const glyph = getGlyph(character);
    for (let row = 0; row < height; row += 1) {
      rows[row] += `${glyph[row] ?? ""}${spacing}`;
    }
  }

  return rows.map((row) => row.trimEnd());
}

function wrapWords(text, maxWidth) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && artWidth(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function artWidth(text) {
  let width = 0;
  const spacing = Math.max(0, Number(font.spacing) || 0);
  for (const character of Array.from(text)) {
    width += visibleGlyphWidth(getGlyph(character)) + spacing;
  }
  return Math.max(0, width - spacing);
}

function visibleGlyphWidth(glyph) {
  return Math.max(...glyph.map((row) => row.length));
}

function getGlyph(character) {
  const glyphs = font.glyphs && typeof font.glyphs === "object" ? font.glyphs : fallbackFont.glyphs;
  const glyph = glyphs[character] ?? glyphs[character.toLowerCase()] ?? glyphs["?"] ?? fallbackFont.glyphs["?"];
  const height = Number(font.height) || 5;
  if (!Array.isArray(glyph)) return fallbackFont.glyphs["?"];
  return Array.from({ length: height }, (_, index) => String(glyph[index] ?? ""));
}

function colorArtRows(rows, colors) {
  const blockHeight = Number(font.height) || 6;
  return rows.map((row, index) => color(row, colors[Math.floor(index / blockHeight) % colors.length]));
}

function styleArtRows(rows, styles) {
  const blockHeight = Number(font.height) || 6;
  const palette = styles.filter(Boolean);
  return rows.map((row, index) => `${palette[Math.floor(index / blockHeight) % palette.length] ?? ""}${row}${reset}`);
}

function color(text, colorCode) {
  return `\x1b[38;5;${Number(colorCode) || 15}m${text}${reset}`;
}

function normalizePalette(value) {
  const art = Array.isArray(value?.art) && value.art.length > 0 ? value.art : fallbackPalette.art;
  return {
    name: value?.name ?? "custom",
    from: value?.from ?? fallbackPalette.from,
    hint: value?.hint ?? fallbackPalette.hint,
    art,
  };
}

function pick(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values[Math.floor(Math.random() * values.length)];
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  } catch {
    return fallback;
  }
}
