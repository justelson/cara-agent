import { listCustomCommands, listZyraThemes } from "./zyra-sdk.mjs";
import { applyFileMentionSuggestion, getFileMentionSuggestions } from "./file-mentions.mjs";

const COMMANDS = [
  { value: "/commands", label: "/commands", description: "show controls", kind: "command", submitOnEnter: true },
  { value: "/start", label: "/start", description: "ask for the repo starting point", kind: "command", submitOnEnter: true },
  { value: "/new", label: "/new", description: "fresh chat like Pi", kind: "command", submitOnEnter: true },
  { value: "/session", label: "/session", description: "project, model, context, usage", kind: "command", submitOnEnter: true },
  { value: "/chat", label: "/chat", description: "current chat file and totals", kind: "command", submitOnEnter: true },
  { value: "/profile", label: "/profile", description: "show or switch elson/cara mode", kind: "command" },
  { value: "/thinking", label: "/thinking", description: "cycle or set thinking effort", kind: "command" },
  { value: "/themes", label: "/themes", description: "pick a theme", kind: "command", submitOnEnter: false },
  { value: "/models", label: "/models", description: "open model picker", kind: "command" },
  { value: "/memory", label: "/memory", description: "summarize what Zyra knows about Cara", kind: "command", submitOnEnter: true },
  { value: "/auth", label: "/auth", description: "account, plan, and Codex limits", kind: "command", submitOnEnter: true },
  { value: "/account", label: "/account", description: "same as /auth", kind: "command", submitOnEnter: true },
  { value: "/codexusage", label: "/codexusage", description: "show Codex quota usage", kind: "command", submitOnEnter: true },
  { value: "/login", label: "/login", description: "login with ChatGPT/Codex", kind: "command", submitOnEnter: true },
  { value: "/logout", label: "/logout", description: "clear ChatGPT/Codex login", kind: "command", submitOnEnter: true },
  { value: "/consolidate", label: "/consolidate", description: "clean and update Zyra memory layers", kind: "command", submitOnEnter: true },
  { value: "/reload", label: "/reload", description: "reload Zyra from disk and resume", kind: "command", submitOnEnter: true },
  { value: "/exit", label: "/exit", description: "leave", kind: "command", submitOnEnter: true },
  { value: "/quit", label: "/quit", description: "leave", kind: "command", submitOnEnter: true },
];

export function getSlashSuggestions(runtime, text) {
  const fileMentions = getFileMentionSuggestions(runtime, text);
  if (fileMentions.length > 0) return fileMentions;

  if (!text.startsWith("/")) return [];

  const query = text.toLowerCase();
  if (query.startsWith("/thinking ")) {
    const prefix = query.slice("/thinking ".length);
    return runtime.session
      .getAvailableThinkingLevels()
      .filter((level) => level.startsWith(prefix))
      .map((level) => ({
        value: level,
        label: level,
        description: "thinking effort",
        kind: "argument",
        submitOnEnter: true,
      }));
  }

  if (query.startsWith("/profile ")) {
    const prefix = query.slice("/profile ".length);
    return ["auto", "elson", "cara"]
      .filter((profile) => profile.startsWith(prefix))
      .map((profile) => ({
        value: profile,
        label: profile,
        description: profile === "auto" ? "detect from OS account" : "active profile",
        kind: "argument",
        submitOnEnter: true,
      }));
  }

  if (query.startsWith("/themes ") || query.startsWith("/theme ")) {
    const command = query.startsWith("/theme ") ? "/theme " : "/themes ";
    const prefix = query.slice(command.length);
    return listZyraThemes(runtime)
      .filter((theme) => `${theme.name} ${theme.displayName ?? ""} ${theme.description ?? ""}`.toLowerCase().includes(prefix))
      .map((theme) => ({
        value: theme.name,
        label: theme.name,
        description: theme.name === runtime.terminalTheme?.name ? "active" : (theme.displayName ?? theme.description ?? theme.source),
        kind: "theme",
        previewTheme: theme,
        preview: buildThemePreview(theme),
        submitOnEnter: true,
      }));
  }

  if (query.startsWith("/models ")) {
    const prefix = query.slice("/models ".length);
    const custom = {
      value: "",
      label: "custom",
      description: "type provider/model",
      kind: "custom-model",
    };
    const models = runtime.session.modelRegistry
      .getAvailable()
      .filter((model) => `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(prefix))
      .sort((a, b) => {
        const aActive = a.provider === runtime.session.model?.provider && a.id === runtime.session.model?.id;
        const bActive = b.provider === runtime.session.model?.provider && b.id === runtime.session.model?.id;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
      })
      .map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description:
          model.provider === runtime.session.model?.provider && model.id === runtime.session.model?.id
            ? "active"
            : (model.name ?? model.id),
        kind: "argument",
        submitOnEnter: true,
      }));
    return prefix ? models : [...models, custom];
  }

  const prefix = query.slice(1);
  const customCommands = listCustomCommands(runtime).map((command) => ({
    value: `/${command.name}`,
    label: `/${command.name}`,
    description: command.description,
    kind: "command",
    submitOnEnter: false,
  }));
  return [...COMMANDS, ...customCommands].filter((item) => item.label.slice(1).startsWith(prefix));
}

export function applySlashSuggestion(text, item) {
  if (!item) return text;

  if (item.kind === "file-mention") {
    return applyFileMentionSuggestion(text, item);
  }

  if (item.kind === "command") {
    return item.submitOnEnter ? item.value : `${item.value} `;
  }

  if (item.kind === "custom-model") {
    return "/models ";
  }

  if (item.kind === "theme") {
    const command = text.toLowerCase().startsWith("/theme ") ? "/theme " : "/themes ";
    return `${command}${item.value}`;
  }

  const spaceIndex = text.indexOf(" ");
  if (spaceIndex === -1) {
    return item.value;
  }

  const command = text.slice(0, spaceIndex + 1);
  return `${command}${item.value}`;
}

function buildThemePreview(theme) {
  const colors = theme?.colors ?? {};
  return [colors.primary, colors.accent, colors.success, colors.warning]
    .filter(Boolean)
    .slice(0, 4)
    .map((color) => colorBlock(color))
    .join("");
}

function colorBlock(color) {
  const rgb = parseHexColor(color);
  if (rgb) return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m  \x1b[0m`;
  const number = Number(color);
  if (Number.isFinite(number)) return `\x1b[48;5;${Math.max(0, Math.min(255, Math.round(number)))}m  \x1b[0m`;
  return "";
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
