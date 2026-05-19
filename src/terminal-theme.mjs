import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reset = "\x1b[0m";
const terminalThemeMarker = Symbol.for("cara.terminalTheme");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TERMINAL_THEME = "rose-pine";

const localBuiltInThemes = [
  {
    name: "quiet",
    description: "Muted Pi-like default. Low color, low glare.",
    source: "built-in",
    colors: {
      muted: 244,
      primary: 109,
      success: 108,
      warning: 179,
      error: 167,
      accent: 73,
      info: 110,
      editorBorder: 238,
      userBg: "#111418",
      userFg: 250,
      toolBg: "#161a20",
      toolSuccessBg: "#151d18",
      toolErrorBg: "#241819",
      toolFg: 250,
      toolTitleFg: 252,
      toolDetailFg: 246,
      toolHintFg: 243,
    },
  },
  {
    name: "dusk",
    description: "Soft violet/amber evening palette.",
    source: "built-in",
    colors: {
      muted: 245,
      primary: 104,
      success: 108,
      warning: 180,
      error: 174,
      accent: 140,
      info: 110,
      editorBorder: 240,
      userBg: "#17151d",
      userFg: 252,
      toolBg: "#1b1822",
      toolSuccessBg: "#182018",
      toolErrorBg: "#261a1d",
      toolFg: 250,
      toolTitleFg: 255,
      toolDetailFg: 247,
      toolHintFg: 181,
    },
  },
  {
    name: "vivid",
    description: "The brighter old Cara feel.",
    source: "built-in",
    colors: {
      muted: 245,
      primary: 36,
      success: 32,
      warning: 33,
      error: 31,
      accent: 35,
      info: 34,
      editorBorder: 36,
      userBg: "#141821",
      userFg: 97,
      toolBg: "#282832",
      toolSuccessBg: "#283228",
      toolErrorBg: "#3c2828",
      toolFg: "#f5f5f2",
      toolTitleFg: "#ffffff",
      toolDetailFg: "#bec6be",
      toolHintFg: "#8abeb7",
    },
  },
];

const builtInThemes = [...localBuiltInThemes, ...loadUiCatalogThemes()];

export function buildTerminalTheme(themeInput = {}) {
  if (themeInput?.[terminalThemeMarker]) return themeInput;
  const definition = normalizeThemeDefinition(themeInput) ?? getDefaultTheme();
  const colors = { ...getDefaultTheme().colors, ...(definition.colors ?? {}) };
  return {
    [terminalThemeMarker]: true,
    name: definition.name ?? DEFAULT_TERMINAL_THEME,
    description: definition.description ?? "",
    muted: fg(colors.muted),
    dimMuted: `\x1b[2m${fg(colors.muted)}`,
    primary: fg(colors.primary),
    success: fg(colors.success),
    warning: fg(colors.warning),
    error: fg(colors.error),
    accent: fg(colors.accent),
    info: fg(colors.info),
    editorBorder: fg(colors.editorBorder ?? colors.primary),
    userBg: bg(colors.userBg),
    userFg: textStyle(colors.userFg, { bold: true }),
    toolBg: bg(colors.toolBg),
    toolSuccessBg: bg(colors.toolSuccessBg),
    toolErrorBg: bg(colors.toolErrorBg),
    toolFg: fg(colors.toolFg),
    toolTitleFg: textStyle(colors.toolTitleFg, { bold: true }),
    toolDetailFg: fg(colors.toolDetailFg),
    toolHintFg: fg(colors.toolHintFg),
    reset,
  };
}

export function applyTerminalTheme(target, nextTheme) {
  const resolved = buildTerminalTheme(nextTheme);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, resolved);
  target[terminalThemeMarker] = true;
  return target;
}

export function listTerminalThemes(options = {}) {
  const themes = new Map();
  for (const theme of builtInThemes) themes.set(theme.name, theme);
  for (const theme of loadThemeDirectory(options.root && path.join(options.root, "themes"), "global")) {
    themes.set(theme.name, theme);
  }
  for (const theme of loadThemeDirectory(options.project && path.join(options.project, ".cara", "themes"), "project")) {
    themes.set(theme.name, theme);
  }
  return [...themes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveTerminalTheme(selector = DEFAULT_TERMINAL_THEME, options = {}) {
  const value = String(selector ?? "").trim() || DEFAULT_TERMINAL_THEME;
  const themes = listTerminalThemes(options);
  const exact = themes.find((theme) => theme.name.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const fuzzy = themes.find((theme) => theme.name.toLowerCase().includes(value.toLowerCase()));
  if (fuzzy) return fuzzy;
  throw new Error(`Theme not found: ${value}. Try /themes.`);
}

export function fg(code) {
  if (code === "" || code === undefined || code === null) return "";
  const rgb = parseHexColor(code);
  if (rgb) return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
  return `\x1b[38;5;${clampColor(code, 15)}m`;
}

function bg(code) {
  if (code === "" || code === undefined || code === null) return "";
  const rgb = parseHexColor(code);
  if (rgb) return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  return `\x1b[48;5;${clampColor(code, 0)}m`;
}

function textStyle(code, options = {}) {
  const prefix = options.bold ? "\x1b[1m" : "";
  return `${prefix}${fg(code)}`;
}

function normalizeThemeDefinition(value) {
  if (typeof value === "string") return resolveBuiltIn(value);
  if (!value || typeof value !== "object") return getDefaultTheme();
  if (value.colors && typeof value.colors === "object") return value;
  if (value.name && builtInThemes.some((theme) => theme.name === value.name)) return resolveBuiltIn(value.name);
  return getDefaultTheme();
}

function getDefaultTheme() {
  return resolveBuiltIn(DEFAULT_TERMINAL_THEME);
}

function resolveBuiltIn(name) {
  return builtInThemes.find((theme) => theme.name === name) ?? localBuiltInThemes[0];
}

function loadUiCatalogThemes() {
  const file = path.join(ROOT, "apps", "cara-ui", "src", "renderer", "src", "lib", "settings-theme-catalog.ts");
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8");
    const match = text.match(/export const THEMES\s*=\s*([\s\S]*?)\s*as const satisfies/);
    if (!match) return [];
    const catalog = Function(`"use strict"; return (${match[1]});`)();
    if (!Array.isArray(catalog)) return [];
    return catalog.map(themeFromUiCatalog).filter(Boolean);
  } catch {
    return [];
  }
}

function themeFromUiCatalog(theme) {
  const tokens = theme?.tokens;
  if (!theme?.id || !tokens) return undefined;
  return {
    name: theme.id,
    displayName: theme.name ?? theme.id,
    description: theme.description ?? "Cara UI theme",
    source: "ui-app",
    colors: {
      muted: tokens.textSecondary,
      primary: tokens.primary,
      success: tokens.secondary,
      warning: theme.accentColor === "Yellow" || theme.accentColor === "Orange" ? tokens.primary : "#d8a657",
      error: "#ff6b6b",
      accent: tokens.secondary ?? tokens.primary,
      info: tokens.textSecondary ?? tokens.primary,
      editorBorder: tokens.border,
      userBg: tokens.card,
      userFg: tokens.text,
      toolBg: tokens.card,
      toolSuccessBg: mixHex(tokens.card, tokens.secondary, 0.16),
      toolErrorBg: mixHex(tokens.card, "#ff6b6b", 0.16),
      toolFg: tokens.text,
      toolTitleFg: tokens.text,
      toolDetailFg: tokens.textDark,
      toolHintFg: tokens.textSecondary,
    },
  };
}

function loadThemeDirectory(dir, source) {
  if (!dir || !existsSync(dir)) return [];
  const themes = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed?.name || !parsed?.colors || typeof parsed.colors !== "object") continue;
      themes.push({ ...parsed, source, file });
    } catch {
      // Ignore broken custom themes during startup; /themes should stay usable.
    }
  }
  return themes;
}

function clampColor(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function mixHex(base, overlay, amount = 0.15) {
  const a = parseHexColor(base);
  const b = parseHexColor(overlay);
  if (!a || !b) return base;
  const mix = (left, right) => Math.round(left * (1 - amount) + right * amount);
  return `#${toHex(mix(a.r, b.r))}${toHex(mix(a.g, b.g))}${toHex(mix(a.b, b.b))}`;
}

function toHex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function parseHexColor(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return undefined;
  const hex = match[1].length === 3
    ? match[1].split("").map((char) => `${char}${char}`).join("")
    : match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}
