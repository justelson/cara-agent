import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reset = "\x1b[0m";
const terminalThemeMarker = Symbol.for("zyra.terminalTheme");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TERMINAL_THEME = "rose-pine";

const localBuiltInThemes = [
  {
    name: "rose-pine",
    description: "Dark rose and pine palette. Zyra's default room.",
    source: "built-in",
    colors: {
      muted: "#6e6a86",
      primary: "#eb6f92",
      success: "#9ccfd8",
      warning: "#f6c177",
      error: "#eb6f92",
      accent: "#c4a7e7",
      info: "#31748f",
      editorBorder: "#26233a",
      userBg: "#191724",
      userFg: "#e0def4",
      toolBg: "#1f1d2e",
      toolSuccessBg: "#192b32",
      toolErrorBg: "#321f2b",
      toolFg: "#e0def4",
      toolTitleFg: "#f4ede8",
      toolDetailFg: "#908caa",
      toolHintFg: "#6e6a86",
    },
  },
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
    description: "The brighter old Zyra feel.",
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
  const toolCall = resolveToolCallColors(colors);
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
    toolBg: bg(toolCall.background),
    toolSuccessBg: bg(toolCall.successBackground),
    toolErrorBg: bg(toolCall.errorBackground),
    toolFg: fg(toolCall.text),
    toolTitleFg: textStyle(toolCall.title, { bold: true }),
    toolDetailFg: fg(toolCall.detail),
    toolHintFg: fg(toolCall.hint),
    toolRailFg: fg(toolCall.rail),
    toolMarkerFg: fg(toolCall.marker),
    toolNameFg: textStyle(toolCall.name, { bold: true }),
    toolStateRunningFg: fg(toolCall.running),
    toolStateSuccessFg: fg(toolCall.success),
    toolStateErrorFg: fg(toolCall.error),
    toolArgsFg: fg(toolCall.args),
    toolOutputFg: fg(toolCall.output),
    toolDimFg: fg(toolCall.muted),
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
  for (const theme of loadThemeDirectory(options.project && path.join(options.project, ".cara", "themes"), "legacy-project")) {
    themes.set(theme.name, theme);
  }
  for (const theme of loadThemeDirectory(options.project && path.join(options.project, ".zyra", "themes"), "project")) {
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
  const fallback = themes.find((theme) => theme.name === DEFAULT_TERMINAL_THEME) ?? localBuiltInThemes[0];
  if (value !== DEFAULT_TERMINAL_THEME) return fallback;
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
    description: theme.description ?? "Zyra UI theme",
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
      toolCall: {
        background: mixHex(tokens.card, tokens.primary, 0.06),
        successBackground: mixHex(tokens.card, tokens.secondary, 0.12),
        errorBackground: mixHex(tokens.card, "#ff6b6b", 0.12),
        rail: tokens.borderSecondary ?? tokens.border,
        marker: tokens.primary,
        name: tokens.primary,
        running: tokens.primary,
        success: tokens.secondary ?? tokens.primary,
        error: "#ff6b6b",
        args: tokens.textDarker ?? tokens.textSecondary,
        output: tokens.textDark ?? tokens.text,
        detail: tokens.textDarker ?? tokens.textSecondary,
        hint: tokens.textSecondary ?? tokens.textDarker,
        muted: tokens.textMuted ?? tokens.textSecondary,
      },
    },
  };
}

function resolveToolCallColors(colors = {}) {
  const toolCall = colors.toolCall && typeof colors.toolCall === "object" ? colors.toolCall : {};
  return {
    background: pickColor(toolCall.background, colors.toolBg, colors.accent, colors.userBg),
    successBackground: pickColor(toolCall.successBackground, colors.toolSuccessBg, colors.toolBg, colors.accent),
    errorBackground: pickColor(toolCall.errorBackground, colors.toolErrorBg, colors.toolBg, colors.accent),
    text: pickColor(toolCall.text, colors.toolFg, colors.text, colors.userFg, colors.primary),
    title: pickColor(toolCall.title, colors.toolTitleFg, toolCall.name, colors.toolFg, colors.primary),
    detail: pickColor(toolCall.detail, colors.toolDetailFg, colors.muted, colors.toolFg),
    hint: pickColor(toolCall.hint, colors.toolHintFg, colors.muted, colors.toolFg),
    rail: pickColor(toolCall.rail, colors.toolRailFg, colors.editorBorder, colors.muted, colors.primary),
    marker: pickColor(toolCall.marker, colors.toolMarkerFg, colors.accent, colors.primary),
    name: pickColor(toolCall.name, colors.toolNameFg, colors.primary, colors.toolTitleFg, colors.toolFg),
    running: pickColor(toolCall.running, colors.toolRunningFg, colors.warning, colors.primary),
    success: pickColor(toolCall.success, colors.toolSuccessFg, colors.success, colors.primary),
    error: pickColor(toolCall.error, colors.toolErrorFg, colors.error, colors.warning),
    args: pickColor(toolCall.args, colors.toolArgsFg, colors.toolDetailFg, colors.muted, colors.toolFg),
    output: pickColor(toolCall.output, colors.toolOutputFg, colors.toolDetailFg, colors.toolFg, colors.muted),
    muted: pickColor(toolCall.muted, colors.toolDimFg, colors.toolHintFg, colors.muted, colors.toolFg),
  };
}

function pickColor(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
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
