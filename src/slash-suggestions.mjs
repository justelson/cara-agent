const COMMANDS = [
  { value: "/commands", label: "/commands", description: "show controls", kind: "command", submitOnEnter: true },
  { value: "/status", label: "/status", description: "project, model, thinking", kind: "command", submitOnEnter: true },
  { value: "/thinking", label: "/thinking", description: "cycle or set thinking effort", kind: "command" },
  { value: "/models", label: "/models", description: "open model picker", kind: "command" },
  { value: "/sessions", label: "/sessions", description: "show local chats", kind: "command", submitOnEnter: true },
  { value: "/exit", label: "/exit", description: "leave", kind: "command", submitOnEnter: true },
];

export function getSlashSuggestions(runtime, text) {
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
  return COMMANDS.filter((item) => item.label.slice(1).startsWith(prefix));
}

export function applySlashSuggestion(text, item) {
  if (!item) return text;

  if (item.kind === "command") {
    return item.submitOnEnter ? item.value : `${item.value} `;
  }

  if (item.kind === "custom-model") {
    return "/models ";
  }

  const spaceIndex = text.indexOf(" ");
  if (spaceIndex === -1) {
    return item.value;
  }

  const command = text.slice(0, spaceIndex + 1);
  return `${command}${item.value}`;
}
