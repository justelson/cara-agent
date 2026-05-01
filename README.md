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
- show loaded memory and custom commands with `/memory`
- show Cara's voice/product map with `/touch`
- run markdown commands from `commands/*.md` or `<project>\.cara\commands\*.md`
- exit

Chats are stored under the active project folder at `<project>\.cara\sessions` using pi's JSONL session format. Use `sessions` to list project chats, `continue` or `--continue` to keep going from the newest chat, `resume` to open the picker, and `resume <id>` or `--session <id>` to open a specific one.

## Human Touch Layer

The CLI loads `AGENTS.md` files as project memory, keeps the banner copy warm but compact, and includes three starter commands:

- `/second-look`
- `/repair-render`
- `/archive-ground`
