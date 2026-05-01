import { Markdown } from "@mariozechner/pi-tui";

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

const markdownTheme = {
  heading: (text) => wrap(ansi.bold, text),
  link: (text) => wrap(ansi.cyan, text),
  linkUrl: (text) => wrap(ansi.dim, text),
  code: (text) => wrap(ansi.yellow, text),
  codeBlock: (text) => text,
  codeBlockBorder: (text) => wrap(ansi.dim, text),
  quote: (text) => wrap(ansi.dim, text),
  quoteBorder: (text) => wrap(ansi.dim, text),
  hr: (text) => wrap(ansi.dim, text),
  listBullet: (text) => wrap(ansi.cyan, text),
  bold: (text) => wrap(ansi.bold, text),
  italic: (text) => wrap(ansi.italic, text),
  underline: (text) => wrap(ansi.underline, text),
  strikethrough: (text) => wrap(ansi.strike, text),
  highlightCode: (code) => code.split("\n"),
};

export function renderMarkdown(text, width = process.stdout.columns ?? 100) {
  const markdown = new Markdown(text.trim(), 0, 0, markdownTheme);
  return markdown.render(Math.max(24, width));
}
