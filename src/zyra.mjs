#!/usr/bin/env node
import { copyFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  buildInspectPrompt,
  buildZyraAuthAccountStatus,
  buildZyraMemoryJobs,
  buildZyraMemorySearch,
  buildZyraMemorySources,
  buildSessionInfo,
  checkSetup,
  createZyraSession,
  defaults,
  describeRuntime,
  disableZyraMemorySource,
  fetchCodexUsageStats,
  loadCustomCommand,
  loginZyraAuth,
  listZyraSessions,
  rebuildZyraMemorySources,
  reloadZyraRuntime,
  runZyraMemoryConsolidation,
  runZyraRuntimeMemoryStartup,
  runZyraPrompt,
  runZyraPrintPrompt,
  saveZyraExitSummary,
  logoutZyraAuth,
  setZyraTheme,
  setModel,
  setProfile,
  setThinking,
} from "./zyra-sdk.mjs";
import { createZyraUi } from "./zyra-ui.mjs";
import { buildProjectStartPrompt } from "./project-start.mjs";
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
  let printMode = false;
  let model = "";
  let profile = "";
  let terminalTheme = "";

  if (args[0] === "--help" || args[0] === "-h") {
    return { command: args[0], project, prompt, sessionMode, session, noSession, pickSession, printMode, model, profile, terminalTheme };
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
    } else if (arg === "--model" && args[i + 1]) {
      model = args[i + 1];
      i += 1;
    } else if (arg === "--profile" && args[i + 1]) {
      profile = args[i + 1];
      i += 1;
    } else if (arg === "--theme" && args[i + 1]) {
      terminalTheme = args[i + 1];
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
    } else if (arg === "--update") {
      command = "update";
    } else if (arg === "--print" || arg === "-p") {
      printMode = true;
      command = command === "chat" ? "ask" : command;
    } else {
      prompt = prompt ? `${prompt} ${arg}` : arg;
    }
  }

  if (command === "here") {
    command = "chat";
    project = process.env.ZYRA_CALLER_CWD ?? process.env.CARA_CALLER_CWD ?? process.cwd();
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
    throw new Error('Usage: zyra ask "your question" or zyra -p "your question"');
  }
  if (!["chat", "ask", "inspect", "doctor", "sessions", "login", "logout", "auth", "account", "codexusage", "update", "help", "--help", "-h"].includes(command)) {
    prompt = command + (prompt ? ` ${prompt}` : "");
    command = "ask";
  }
  if (printMode && !prompt) {
    throw new Error('Usage: zyra -p "your question"');
  }

  return { command, project, prompt, sessionMode, session, noSession, pickSession, printMode, model, profile, terminalTheme };
}

function runUpdate() {
  const root = defaults.root;
  if (process.platform === "win32") {
    const script = path.join(root, "install.ps1");
    const tempScript = path.join(os.tmpdir(), `zyra-update-${process.pid}.ps1`);
    copyFileSync(script, tempScript);
    process.chdir(os.tmpdir());
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      tempScript,
      "-InstallDir",
      root,
      "-Update",
      "-Yes",
    ], { stdio: "inherit", cwd: os.tmpdir() });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }

  const script = path.join(root, "install.sh");
  const result = spawnSync("bash", [script], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
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

async function printSessions(_ui, _project) {
  console.log("Use `zyra resume` to browse chats, or `/chat` inside Zyra for the current chat.");
}

async function main() {
  let ui = createZyraUi();
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
  if (parsed.command === "update") {
    runUpdate();
    return;
  }
  if (parsed.command === "login") {
    const provider = parsed.prompt || "openai-codex";
    console.log(`Logging in to ${provider} using Pi auth...`);
    await loginZyraAuth(provider);
    ui.account(await buildZyraAuthAccountStatus(provider));
    return;
  }
  if (parsed.command === "logout") {
    const provider = parsed.prompt || "openai-codex";
    console.log(`Logging out of ${provider}...`);
    await logoutZyraAuth(provider);
    ui.account(await buildZyraAuthAccountStatus(provider));
    return;
  }
  if (parsed.command === "auth" || parsed.command === "account") {
    ui.account(await buildZyraAuthAccountStatus(parsed.prompt || "openai-codex"));
    return;
  }
  if (parsed.command === "codexusage") {
    ui.codexUsage(await fetchCodexUsageStats());
    return;
  }

  if (parsed.pickSession) {
    const sessions = await listZyraSessions({ project: parsed.project });
    const selected = await selectSession(sessions);
    if (!selected) return;
    parsed.session = selected;
  }

  const runtimeOptions = {
    project: parsed.project,
    sessionMode: parsed.sessionMode,
    session: parsed.session,
    noSession: parsed.noSession || (parsed.printMode && parsed.sessionMode === "new" && !parsed.session),
    model: parsed.model || undefined,
    profile: parsed.profile || undefined,
    terminalTheme: parsed.terminalTheme || undefined,
  };

  if (parsed.printMode || parsed.prompt) {
    const runtime = await createZyraSession(runtimeOptions);
    ui = createZyraUi({ openingTheme: runtime.theme, terminalTheme: runtime.terminalTheme });

    if (parsed.printMode) {
      if (runtime.modelFallbackMessage) {
        console.error(runtime.modelFallbackMessage);
      }
      try {
        const text = await runZyraPrintPrompt(runtime, parsed.prompt);
        if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      } finally {
        runtime.session.dispose();
      }
      return;
    }

    runtime.session.subscribe((event) => ui.event(event));
    const status = describeRuntime(runtime);
    ui.banner(status);
    if (runtime.modelFallbackMessage) {
      console.log(runtime.modelFallbackMessage);
    }
    await runZyraPrompt(runtime, parsed.prompt);
    ui.done();
    runtime.session.dispose();
    return;
  }

  const stopStarting = ui.starting("Starting agent");
  let runtime = await createZyraSession(runtimeOptions).finally(stopStarting);
  ui.setTheme(runtime.terminalTheme);
  ui.banner(describeRuntime(runtime));
  let unsubscribe = runtime.session.subscribe((event) => ui.event(event));
  if (runtime.modelFallbackMessage) {
    ui.info(runtime.modelFallbackMessage);
  }

  let exitRequested = false;
  let restartMode = "";
  let activeRun = false;
  let pendingMidRunInputs = [];
  let abortRequested = false;
  let suppressNextAbortError = false;

  const startFreshChat = async () => {
    ui.info("Starting a fresh Zyra chat...");
    const nextRuntime = await createZyraSession({
      ...runtimeOptions,
      sessionMode: "new",
      session: "",
    });
    unsubscribe?.();
    runtime.session.dispose();
    runtime = nextRuntime;
    ui.setTheme(runtime.terminalTheme);
    ui.resetSession(describeRuntime(runtime));
    unsubscribe = runtime.session.subscribe((event) => ui.event(event));
    if (runtime.modelFallbackMessage) {
      ui.info(runtime.modelFallbackMessage);
    }
  };

  const runPromptTurn = async (submission) => {
    const text = getSubmissionText(submission);
    const slashResult = await handleSlash(runtime, ui, text, { startFreshChat });
    if (slashResult) {
      restartMode = slashResult === "restart" ? slashResult : "";
      exitRequested = Boolean(restartMode) || isExitInput(text);
      if (!exitRequested) {
        await drainPendingMidRunInputs();
      }
      return exitRequested;
    }
    await runZyraPrompt(runtime, text, getSubmissionOptions(submission));
    await drainPendingMidRunInputs();
    return false;
  };

  const drainPendingMidRunInputs = async () => {
    if (abortRequested || pendingMidRunInputs.length === 0) return;
    const updates = pendingMidRunInputs;
    pendingMidRunInputs = [];
    const followUp = buildMidRunFollowUpPrompt(updates);
    await runZyraPrompt(runtime, followUp);
    await drainPendingMidRunInputs();
  };

  await ui.interactive(async (submission) => {
    try {
      const text = getSubmissionText(submission);
      if (activeRun) {
        if (isHardInterruptInput(text)) {
          abortRequested = true;
          suppressNextAbortError = true;
          pendingMidRunInputs = [];
          ui.info("Stopping this run.");
          await runtime.session.abort?.();
          return false;
        }
        pendingMidRunInputs.push(text);
        ui.info("Got it - I'll fold that in after this step.");
        return false;
      }

      activeRun = true;
      abortRequested = false;
      try {
        return await runPromptTurn(submission);
      } catch (error) {
        if (!(suppressNextAbortError && isExpectedAbortError(error))) {
          ui.error(error);
        }
      } finally {
        activeRun = false;
        abortRequested = false;
        suppressNextAbortError = false;
      }
    } catch (error) {
      ui.error(error);
    }
    return false;
  }, {
    suggestions: (text) => getSlashSuggestions(runtime, text),
    applySuggestion: applySlashSuggestion,
    onSuggestionSelect: (item) => {
      if (item?.kind === "theme" && item.previewTheme) {
        ui.setTheme(item.previewTheme);
      } else {
        ui.setTheme(runtime.terminalTheme);
      }
    },
    statusLine: (width, state) => renderStatusLine(runtime, width, state),
    theme: runtime.terminalTheme,
  });
  if (restartMode) {
    restartZyraProcess(runtime, { mode: restartMode });
    return;
  }
  if (exitRequested) {
    const exitSummary = ui.goodbye(describeRuntime(runtime));
    saveZyraExitSummary(runtime, exitSummary);
  }
  unsubscribe?.();
  runtime.session.dispose();
}

async function handleSlash(runtime, ui, input, controls = {}) {
  const text = input.trim();
  if (!text.startsWith("/") && !["exit", "quit"].includes(text)) return false;

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ");

  if (command === "/exit" || command === "/quit" || text === "exit" || text === "quit") return true;
  if (command === "/commands" || command === "/help") {
    ui.commands();
    return true;
  }
  if (command === "/start") {
    ui.beginProgress("Project scan");
    try {
      await runZyraPrompt(runtime, buildProjectStartPrompt(runtime, arg));
    } finally {
      ui.endProgress();
    }
    return true;
  }
  if (command === "/session") {
    ui.status(describeRuntime(runtime));
    return true;
  }
  if (command === "/profile") {
    if (!arg) {
      ui.info(`Profile: ${describeRuntime(runtime).profile}`);
      return true;
    }
    const profile = setProfile(runtime, arg);
    ui.info(`Profile: ${profile}`);
    return true;
  }
  if (command === "/memory") {
    const [memoryActionRaw, ...memoryRest] = rest;
    const memoryAction = memoryActionRaw?.toLowerCase();
    const memoryArg = memoryRest.join(" ").trim();
    if (!memoryAction) {
      ui.memory(describeRuntime(runtime));
      return true;
    }
    if (memoryAction === "search") {
      const query = memoryArg || arg.replace(/^search\s*/i, "").trim();
      if (!query) ui.info("Usage: /memory search <query>");
      else ui.block(buildZyraMemorySearch(query));
      return true;
    }
    if (memoryAction === "sources") {
      ui.block(buildZyraMemorySources());
      return true;
    }
    if (memoryAction === "jobs") {
      ui.block(buildZyraMemoryJobs());
      return true;
    }
    if (memoryAction === "startup") {
      const result = runZyraRuntimeMemoryStartup(runtime);
      ui.info(`Memory startup: ${result.claimed} claimed, ${result.prepared} prepared, ${result.pruned} pruned.`);
      return true;
    }
    if (memoryAction === "forget") {
      const threadId = memoryArg;
      if (!threadId) {
        ui.info("Usage: /memory forget <source-id>");
      } else if (disableZyraMemorySource(threadId)) {
        ui.info(`Memory source disabled: ${threadId}`);
      } else {
        ui.info(`No memory source found: ${threadId}`);
      }
      return true;
    }
    if (memoryAction === "rebuild") {
      const outputs = rebuildZyraMemorySources();
      ui.info(`Memory inputs rebuilt: ${outputs.length} source${outputs.length === 1 ? "" : "s"}.`);
      return true;
    }
    ui.info("Usage: /memory, /memory search <query>, /memory sources, /memory jobs, /memory startup, /memory forget <source-id>");
    return true;
  }
  if (command === "/auth" || command === "/account") {
    ui.info("Checking auth...");
    ui.account(await buildZyraAuthAccountStatus(arg || "openai-codex"));
    return true;
  }
  if (command === "/codexusage" || command === "/usage") {
    ui.info("Checking Codex usage...");
    ui.codexUsage(await fetchCodexUsageStats());
    return true;
  }
  if (command === "/login") {
    const provider = arg || "openai-codex";
    ui.beginProgress("ChatGPT login");
    try {
      await loginZyraAuth(provider, { onMessage: (message) => ui.info(message) });
      ui.account(await buildZyraAuthAccountStatus(provider));
    } finally {
      ui.endProgress();
    }
    return true;
  }
  if (command === "/logout") {
    const provider = arg || "openai-codex";
    ui.info(`Logging out of ${provider}...`);
    await logoutZyraAuth(provider);
    ui.account(await buildZyraAuthAccountStatus(provider));
    return true;
  }
  if (command === "/reload") {
    if (arg.trim() === "--soft") {
      ui.info("Reloading commands, themes, prompt, and memory without restarting...");
      const result = await reloadZyraRuntime(runtime);
      ui.setTheme(result.theme);
      ui.info(`Reloaded resources: ${result.commands} command${result.commands === 1 ? "" : "s"}, ${result.themes} theme${result.themes === 1 ? "" : "s"}.`);
      return true;
    }
    ui.info("Reloading Zyra from disk and resuming this chat...");
    return "restart";
  }
  if (command === "/new") {
    await controls.startFreshChat?.();
    return true;
  }
  if (command === "/consolidate") {
    ui.beginProgress("Consolidating memory");
    try {
      const result = await runZyraMemoryConsolidation(runtime);
      ui.info(formatMemoryConsolidationResult(result));
    } finally {
      ui.endProgress();
    }
    return true;
  }
  if (command === "/chat") {
    ui.sessionInfo(buildSessionInfo(runtime));
    return true;
  }
  if (command === "/thinking" || command === "/effort") {
    const level = setThinking(runtime, arg);
    ui.info(`Thinking: ${level}`);
    return true;
  }
  if (command === "/themes" || command === "/theme") {
    if (!arg) {
      ui.themes(describeRuntime(runtime).themes, runtime.terminalTheme?.name);
      return true;
    }
    const theme = setZyraTheme(runtime, arg);
    ui.setTheme(theme);
    ui.info(`Theme: ${theme.name}`);
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
    await runZyraPrompt(runtime, customPrompt);
    return true;
  }

  ui.error(new Error("Unknown slash command. Type /commands."));
  return true;
}

function restartZyraProcess(runtime, options = {}) {
  const sessionManager = runtime.session.sessionManager;
  const selector = sessionManager.getSessionId?.() || sessionManager.getSessionFile?.();
  const args = [path.join(runtime.root, "bin", "zyra.mjs")];
  if (options.mode === "new") {
    args.push("new");
  } else if (selector) {
    args.push("resume", selector);
  } else {
    args.push("new");
  }
  args.push("--project", runtime.project);
  if (runtime.profile) args.push("--profile", runtime.profile);
  if (runtime.terminalTheme?.name) args.push("--theme", runtime.terminalTheme.name);
  if (runtime.session.model) args.push("--model", `${runtime.session.model.provider}/${runtime.session.model.id}`);

  runtime.session.dispose();
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    cwd: runtime.root,
    env: {
      ...process.env,
      ZYRA_CALLER_CWD: runtime.project,
      CARA_CALLER_CWD: runtime.project,
    },
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

function formatMemoryConsolidationResult(result) {
  const stage1 = result.stage1 ?? {};
  const phase2 = result.phase2 ?? {};
  const parts = [
    `stage-1 ${stage1.succeeded ?? 0} saved`,
    `${stage1.noOutput ?? 0} no-op`,
    `${stage1.failed ?? 0} failed`,
    `phase-2 ${phase2.status ?? "unknown"}`,
  ];
  if (phase2.selected !== undefined) parts.push(`${phase2.selected} selected`);
  if (phase2.error) parts.push(phase2.error);
  return `Memory consolidated: ${parts.join(", ")}.`;
}

function isExitInput(input) {
  const text = input.trim().toLowerCase();
  return text === "/exit" || text === "/quit" || text === "exit" || text === "quit";
}

function isHardInterruptInput(input) {
  const text = String(input ?? "").trim().toLowerCase();
  return /^(stop|wait|cancel|pause|hold on|nevermind|never mind|wrong|don'?t|do not|abort)\b/.test(text);
}

function buildMidRunFollowUpPrompt(inputs) {
  const body = inputs
    .map((input, index) => `${index + 1}. ${String(input ?? "").trim()}`)
    .filter((line) => !/^\d+\.\s*$/.test(line))
    .join("\n");
  return `The user sent the following while you were already working. Treat it as updated instruction/context for the same task, and continue from the current state without restarting unnecessarily.\n\n${body}`;
}

function isExpectedAbortError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\babort(?:ed)?\b|cancel(?:led|ed)?/i.test(message);
}

function shouldShowStartupRecommendations(parsed) {
  return parsed.command === "chat" && parsed.sessionMode === "new" && !parsed.session && !parsed.prompt;
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
  const ui = createZyraUi();
  ui.error(error);
  process.exit(1);
});
