# Pi CLI

This is a general builder CLI built directly on the local pi SDK.

It uses the current folder as the project, keeps startup quiet, and exposes only a small runtime control surface inside chat.

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

- change thinking effort
- change model
- show local chats
- show status
- summarize what the agent knows about Cara with `/memory`
- clean and update Cara memory layers with `/consolidate`
- run markdown commands from `commands/*.md` or `<project>\.cara\commands\*.md`
- exit

Chats are stored under the active project folder at `<project>\.cara\sessions` using pi's JSONL session format. Use `sessions` to list project chats, `continue` or `--continue` to keep going from the newest chat, `resume` to open the picker, and `resume <id>` or `--session <id>` to open a specific one.

## Cara Memory

The CLI loads `AGENTS.md` files plus layered Cara memory from `.cara/memory`. `/memory` does not dump raw memory files; it gives a compact summary of what the agent currently knows about Cara.

Use `/consolidate` after meaningful sessions. It asks the agent to clean the memory layers, move stable learnings into the right files, remove vague or duplicate notes, and carefully tighten `AGENTS.md` guidance when the way the agent should behave has changed.

The starter workflow commands are:

- `/second-look`
- `/repair-render`
- `/archive-ground`
