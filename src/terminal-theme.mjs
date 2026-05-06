const reset = "\x1b[0m";

const fallback = {
  muted: 245,
  primary: 36,
  success: 32,
  warning: 33,
  error: 31,
  accent: 35,
  info: 34,
  editorBorder: 238,
  userBg: 236,
  userFg: 97,
  toolBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
};

export function buildTerminalTheme(openingTheme = {}) {
  const palette = openingTheme?.palette ?? {};
  const art = Array.isArray(palette.art) ? palette.art : [];
  const mutedColor = palette.hint ?? fallback.muted;
  const primaryColor = art[0] ?? palette.from ?? fallback.primary;
  const accentColor = art[2] ?? fallback.accent;
  return {
    muted: fg(mutedColor),
    dimMuted: `\x1b[2m${fg(mutedColor)}`,
    primary: fg(primaryColor),
    success: fg(art[3] ?? fallback.success),
    warning: fg(art[1] ?? fallback.warning),
    error: fg(fallback.error),
    accent: fg(accentColor),
    info: fg(art[4] ?? fallback.info),
    editorBorder: fg(primaryColor),
    userBg: bg(fallback.userBg),
    userFg: "\x1b[1m\x1b[97m",
    toolBg: bg(fallback.toolBg),
    toolSuccessBg: bg(fallback.toolSuccessBg),
    toolErrorBg: bg(fallback.toolErrorBg),
    toolFg: "\x1b[38;2;245;245;242m",
    toolTitleFg: "\x1b[1m\x1b[38;2;255;255;255m",
    toolDetailFg: "\x1b[38;2;190;198;190m",
    toolHintFg: "\x1b[38;2;138;190;183m",
    reset,
  };
}

export function fg(code) {
  return `\x1b[38;5;${Number(code) || 15}m`;
}

function bg(code) {
  const rgb = parseHexColor(code);
  if (rgb) return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  return `\x1b[48;5;${Number(code) || 0}m`;
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
