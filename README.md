# Cara's Agent

This is a local Cara coding assistant CLI built directly on the Pi SDK.

It uses the current folder as the project, keeps startup quiet, and exposes a small runtime control surface inside chat.

## Start

```powershell
.\cara.ps1
```

## One-Shots

```powershell
.\cara.ps1 inspect
.\cara.ps1 ask "Explain this error simply"
.\cara.ps1 --project "C:\path\to\repo"
.\cara.ps1 sessions
.\cara.ps1 continue
.\cara.ps1 resume
.\cara.ps1 resume 019dd97b
.\cara.ps1 doctor
```

## In Chat

Type `/commands` to see controls.

Available controls are intentionally small:

- search and attach project files in prompts with `@`, for example `explain @src/App.jsx`
- ask the agent to inspect the repo and write a short project-specific starting point with `/start`
- change thinking effort
- change model
- show local chats
- show status
- show or switch the active profile with `/profile`, `/profile elson`, `/profile cara`, or `/profile auto`
- summarize what the agent knows about Cara with `/memory`
- clean and update Cara memory layers with `/consolidate`
- reload custom slash commands with `/reload`
- run markdown commands from `commands/*.md` or `<project>\.cara\commands\*.md`
- exit or quit

Chats are stored under the active project folder at `<project>\.cara\sessions` using pi's JSONL session format. Use `sessions` to list project chats, `continue` or `--continue` to keep going from the newest chat, `resume` to open the picker, and `resume <id>` or `--session <id>` to open a specific one.

## Cara Memory

The CLI loads `AGENTS.md` files plus layered Cara memory from `.cara/memory`. `/memory` does not dump raw memory files; it gives a compact summary of what the agent currently knows about Cara.

The active profile defaults to `elson` on Elson's Windows account and `cara` everywhere else. The profile does not change the warmth of the tool; it only tells the agent whether this is builder/testing work or Cara using the CLI.

Use `/consolidate` after meaningful sessions. It asks the agent to clean the memory layers, move stable learnings into the right files, remove vague or duplicate notes, and carefully tighten `AGENTS.md` guidance when the way the agent should behave has changed.

Custom commands are not prefilled by default. They are meant to grow from repeated real workflows. If Cara keeps doing the same process, the agent can suggest saving it as a slash command. Use:

- `commands\<name>.md` for global Cara CLI commands
- `<project>\.cara\commands\<name>.md` for project-local commands

Run `/reload` after adding or editing command files.
