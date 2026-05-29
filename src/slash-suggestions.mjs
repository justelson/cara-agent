import { listCustomCommands, listZyraThemes } from "./zyra-sdk.mjs";
import { applyFileMentionSuggestion, getFileMentionSuggestions } from "./file-mentions.mjs";
import { listSlashCommandSuggestions, NOTIFICATION_MODES, STATUS_LINE_MODES } from "./slash-commands.mjs";

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

  if (query.startsWith("/web ")) {
    const prefix = query.slice("/web ".length);
    return ["all", "none", "websearch", "webfetch"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({
        value,
        label: value,
        description: "web tools",
        kind: "argument",
        submitOnEnter: true,
      }));
  }

  if (query.startsWith("/websearch ") || query.startsWith("/web-search ") || query.startsWith("/webfetch ") || query.startsWith("/web-fetch ")) {
    const command = query.startsWith("/web-search ")
      ? "/web-search "
      : query.startsWith("/webfetch ")
        ? "/webfetch "
        : query.startsWith("/web-fetch ")
          ? "/web-fetch "
          : "/websearch ";
    const prefix = query.slice(command.length);
    return ["on", "off"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({
        value,
        label: value,
        description: "web search",
        kind: "argument",
        submitOnEnter: true,
      }));
  }

  if (query.startsWith("/statusline ") || query.startsWith("/status-line ")) {
    const command = query.startsWith("/status-line ") ? "/status-line " : "/statusline ";
    return buildSimpleArgumentSuggestions(STATUS_LINE_MODES, query.slice(command.length), "status line mode");
  }

  if (query.startsWith("/notifications ") || query.startsWith("/notify ")) {
    const command = query.startsWith("/notify ") ? "/notify " : "/notifications ";
    return buildSimpleArgumentSuggestions(NOTIFICATION_MODES, query.slice(command.length), "notification mode");
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
        selected: theme.name === runtime.terminalTheme?.name,
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
  return [...listSlashCommandSuggestions(), ...customCommands].filter((item) => item.label.slice(1).startsWith(prefix));
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

function buildSimpleArgumentSuggestions(values, prefix, description) {
  return values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({
      value,
      label: value,
      description,
      kind: "argument",
      submitOnEnter: true,
    }));
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
