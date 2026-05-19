import { Markdown } from "@earendil-works/pi-tui";

const ansi = {
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strike: "\x1b[9m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
};

function wrap(open, text) {
  return `${open}${text}${ansi.reset}`;
}

function createMarkdownTheme(theme = {}) {
  const muted = theme.muted ?? ansi.dim;
  const primary = theme.primary ?? ansi.cyan;
  const accent = theme.accent ?? primary;
  const warning = theme.warning ?? ansi.yellow;
  const success = theme.success ?? accent;

  return {
    heading: (text) => wrap(`${ansi.bold}${primary}`, text),
    link: (text) => wrap(accent, text),
    linkUrl: (text) => wrap(`${ansi.dim}${muted}`, text),
    code: (text) => wrap(warning, text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => wrap(`${ansi.dim}${muted}`, text),
    quote: (text) => wrap(`${ansi.dim}${muted}`, text),
    quoteBorder: (text) => wrap(`${ansi.dim}${muted}`, text),
    hr: (text) => wrap(`${ansi.dim}${muted}`, text),
    listBullet: (text) => wrap(success, text),
    bold: (text) => wrap(ansi.bold, text),
    italic: (text) => wrap(ansi.italic, text),
    underline: (text) => wrap(ansi.underline, text),
    strikethrough: (text) => wrap(ansi.strike, text),
    highlightCode: (code) => code.split("\n"),
  };
}

export function renderMarkdown(text, width = process.stdout.columns ?? 100, theme = {}) {
  const markdown = new Markdown(text.trim(), 0, 0, createMarkdownTheme(theme));
  return markdown.render(Math.max(24, width));
}
