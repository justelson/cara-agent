#!/usr/bin/env node
import path from "node:path";
import {
  buildInspectPrompt,
  buildCaraConsolidationPrompt,
  checkSetup,
  createCaraSession,
  defaults,
  describeRuntime,
  loadCustomCommand,
  listCaraSessions,
  runCaraPrompt,
  saveCaraExitSummary,
  setModel,
  setThinking,
} from "./cara-sdk.mjs";
import { createCaraUi } from "./cara-ui.mjs";
import { selectSession } from "./session-picker.mjs";
import { applySlashSuggestion, getSlashSuggestions } from "./slash-suggestions.mjs";
import { renderStatusLine } from "./status-line.mjs";

function parse(argv) {
  const args = [...argv];
  let command = "chat";
  let project = defaults.project;
  let prompt = "";
  let sessionMode = "new";
  let session = "";
  let noSession = false;
  let pickSession = false;

  if (args[0] === "--help" || args[0] === "-h") {
    return { command: args[0], project, prompt, sessionMode, session, noSession, pickSession };
  }

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--project" || arg === "--cwd") && args[i + 1]) {
      project = path.resolve(args[i + 1]);
      i += 1;
    } else if (arg === "--thinking" && args[i + 1]) {
      defaults.thinking = args[i + 1];
      i += 1;
    } else if ((arg === "--continue" || arg === "-c")) {
      sessionMode = "continue";
    } else if (arg === "--session" && args[i + 1]) {
      session = args[i + 1];
      i += 1;
    } else if ((arg === "--resume" || arg === "-r") && args[i + 1] && !args[i + 1].startsWith("-")) {
      session = args[i + 1];
      i += 1;
    } else if (arg === "--resume" || arg === "-r") {
      pickSession = true;
    } else if (arg === "--no-session") {
      noSession = true;
    } else {
      prompt = prompt ? `${prompt} ${arg}` : arg;
    }
  }

  if (command === "here") {
    command = "chat";
    project = process.env.CARA_CALLER_CWD ?? process.cwd();
  }
  if (command === "inspect") {
    prompt = buildInspectPrompt();
  }
  if (command === "continue") {
    command = "chat";
    sessionMode = "continue";
  }
  if (command === "resume") {
    command = "chat";
    if (prompt) {
      session = prompt;
      prompt = "";
    } else {
      pickSession = true;
    }
  }
  if (command === "new") {
    command = "chat";
    sessionMode = "new";
  }
  if (command === "ask" && !prompt) {
    throw new Error('Usage: cara ask "your question"');
  }
  if (!["chat", "ask", "inspect", "doctor", "sessions", "help", "--help", "-h"].includes(command)) {
    prompt = command + (prompt ? ` ${prompt}` : "");
    command = "ask";
  }

  return { command, project, prompt, sessionMode, session, noSession, pickSession };
}

function printDoctor(ui) {
  const status = checkSetup();
  ui.banner({
    project: defaults.project,
    mode: "doctor",
    thinking: defaults.thinking,
    model: "not loaded",
  });
  for (const [key, value] of Object.entries(status)) {
    console.log(`${key}: ${value ? "ok" : "missing"}`);
  }
  if (Object.values(status).some((value) => !value)) process.exit(1);
}

async function printSessions(ui, project) {
  const sessions = await listCaraSessions({ project });
  ui.sessions(sessions);
}

async function main() {
  let ui = createCaraUi();
  const parsed = parse(process.argv.slice(2));

  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    ui.commands();
    return;
  }
  if (parsed.command === "doctor") {
    printDoctor(ui);
    return;
  }
  if (parsed.command === "sessions") {
    await printSessions(ui, parsed.project);
    return;
  }

  if (parsed.pickSession) {
    const sessions = await listCaraSessions({ project: parsed.project });
    const selected = await selectSession(sessions);
    if (!selected) return;
    parsed.session = selected;
  }

  const runtime = await createCaraSession({
    project: parsed.project,
    sessionMode: parsed.sessionMode,
    session: parsed.session,
    noSession: parsed.noSession,
  });
  ui = createCaraUi({ theme: runtime.theme });
  runtime.session.subscribe((event) => ui.event(event));
  const status = describeRuntime(runtime);
  ui.banner({
    project: runtime.project,
    mode: parsed.command === "chat" ? "chat" : "one-shot",
    thinking: status.thinking,
    model: status.model,
  });

  if (runtime.modelFallbackMessage) {
    console.log(runtime.modelFallbackMessage);
  }

  if (parsed.prompt) {
    await runCaraPrompt(runtime, parsed.prompt);
    ui.done();
    runtime.session.dispose();
    return;
  }

  let exitRequested = false;
  await ui.interactive(async (submission) => {
    try {
      const text = getSubmissionText(submission);
      if (await handleSlash(runtime, ui, text)) {
        exitRequested = isExitInput(text);
        return exitRequested;
      }
      await runCaraPrompt(runtime, text, getSubmissionOptions(submission));
    } catch (error) {
      ui.error(error);
    }
    return false;
  }, {
    suggestions: (text) => getSlashSuggestions(runtime, text),
    applySuggestion: applySlashSuggestion,
    statusLine: (width, state) => renderStatusLine(runtime, width, state),
    theme: runtime.theme,
  });
  if (exitRequested) {
    const exitSummary = ui.goodbye(describeRuntime(runtime));
    saveCaraExitSummary(runtime, exitSummary);
  }
  runtime.session.dispose();
}

async function handleSlash(runtime, ui, input) {
  const text = input.trim();
  if (!text.startsWith("/") && !["exit", "quit"].includes(text)) return false;

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ");

  if (command === "/exit" || text === "exit" || text === "quit") return true;
  if (command === "/commands" || command === "/help") {
    ui.commands();
    return true;
  }
  if (command === "/status") {
    ui.status(describeRuntime(runtime));
    return true;
  }
  if (command === "/memory") {
    ui.memory(describeRuntime(runtime));
    return true;
  }
  if (command === "/consolidate") {
    await runCaraPrompt(runtime, buildCaraConsolidationPrompt(runtime));
    return true;
  }
  if (command === "/sessions" || command === "/chats") {
    ui.sessions(await listCaraSessions({ project: runtime.project, sessions: runtime.sessions }));
    return true;
  }
  if (command === "/thinking" || command === "/effort") {
    const level = setThinking(runtime, arg);
    ui.info(`Thinking: ${level}`);
    return true;
  }
  if (command === "/models") {
    if (!arg) {
      ui.info("Choose a model from the picker: type /models and press Enter.");
      return true;
    }
    const model = await setModel(runtime, arg);
    ui.info(`Model: ${model.provider}/${model.id}`);
    return true;
  }
  const customPrompt = loadCustomCommand(runtime, command, arg);
  if (customPrompt) {
    await runCaraPrompt(runtime, customPrompt);
    return true;
  }

  ui.error(new Error("Unknown slash command. Type /commands."));
  return true;
}

function isExitInput(input) {
  const text = input.trim().toLowerCase();
  return text === "/exit" || text === "exit" || text === "quit";
}

function getSubmissionText(submission) {
  if (typeof submission === "string") return submission;
  return String(submission?.text ?? "");
}

function getSubmissionOptions(submission) {
  if (!submission || typeof submission === "string") return {};
  return {
    images: Array.isArray(submission.images) ? submission.images : undefined,
  };
}

main().catch((error) => {
  const ui = createCaraUi();
  ui.error(error);
  process.exit(1);
});
