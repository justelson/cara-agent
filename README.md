# Zyra

I made this for Cara.

Cara is the person. Zyra is the tool.

Zyra is a local CLI built on top of the Pi SDK. It runs in whatever project folder you open it from, saves chats locally, can read and edit files, can run checks, and keeps a Cara-specific behavior layer so the interaction feels like a small workshop instead of a classroom.

## Why

Because Cara is new to this, but she is not helpless.

The loop is still the point:

- she notices something feels off
- she says it in normal words
- Zyra checks the real files
- it explains only the next useful thing
- it makes the smallest serious fix
- it runs or names the check
- it explains the diff
- she leaves knowing a little more than before

Not a course. Not a chatbot pretending to be a teacher. A local workshop she can keep coming back to.

## What Changed In 0.2.0

- The CLI is now `zyra`.
- The package is now `zyra@0.2.0`.
- Project-local state uses `.zyra/`.
- The old `cara` command and `.cara/` compatibility path have been removed.
- Cara remains the person/profile/archive name.

## Run It Locally

```powershell
.\zyra.ps1
```

## Install Or Update

Fresh Windows install from PowerShell:

```powershell
irm https://raw.githubusercontent.com/justelson/zyra/master/install.ps1 | iex
```

Fresh Windows install from Command Prompt:

```cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/justelson/zyra/master/install.ps1 | iex"
```

That installs Zyra into:

```txt
%LOCALAPPDATA%\Zyra
```

and adds the `zyra` command to the user PATH.

On first run, `zyra` opens a short onboarding flow for Cara: what Zyra is, ChatGPT login, theme, web tools, and a first prompt she can ask.

From a local clone:

```powershell
.\install.ps1
```

or:

```cmd
install.cmd
```

On macOS/Linux:

```bash
bash install.sh
```

## Auth Setup

Zyra uses Pi auth under the hood, so ChatGPT/Codex credentials stay in the same Pi auth file:

```txt
~/.pi/agent/auth.json
```

On Cara's machine, the first-run onboarding can guide login. Manual login also works:

```powershell
zyra login
```

Useful account commands:

```powershell
zyra auth
zyra account
zyra codexusage
zyra logout
```

Do not copy Elson's `auth.json` to Cara's machine. Let her log in so the tokens belong to her account.

## Common Commands

```powershell
zyra
zyra onboarding
zyra inspect
zyra ask "Explain this error simply"
zyra -p "Explain this error simply"
zyra --project "C:\path\to\repo"
zyra --web
zyra --no-websearch
zyra --no-webfetch
zyra sessions
zyra continue
zyra resume
zyra doctor
zyra --update
```

Inside chat:

- `@file` attaches project files to the prompt.
- `/start` scans the current repo and gives a plain starting point.
- `/new` starts a fresh chat.
- `/session` shows project/session/model info.
- `/profile` switches between `elson`, `cara`, and `auto`.
- `/memory` summarizes what Zyra knows about Cara.
- `/web` opens web tool selection: all, none, search only, or fetch only.
- `/websearch` toggles search results. `/webfetch` toggles URL page fetching.
- `/consolidate` cleans up local memory after meaningful sessions.
- `/themes`, `/thinking`, and `/models` adjust runtime behavior.
- `/reload` restarts Zyra from disk and resumes the chat.
- `/reload --soft` reloads commands, themes, prompt, and memory only.

## Project Shape

- `src/` is the terminal app: input, status line, slash commands, file mentions, session handling, and Pi SDK wiring.
- `prompts/zyra-workshop-guide.md` is the main guide for how Zyra should teach, fix, pause, explain, and not overdo it.
- `AGENTS.md` keeps project rules that should survive across chats.
- `commands/` is where repeated workflows can become slash commands.
- `.zyra/commands/<name>.md` is the project-local command path.

Commands should still earn their place. The tool should grow from real use, not from pretending we already know every workflow Cara will need.
