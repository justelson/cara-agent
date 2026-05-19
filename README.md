# Cara

I made this for Cara.

Not because i wanted to make another coding tutor or some polished AI productivity thing. I made it because i wanted her first real way into software to feel less cold.

Like, if she is going to learn coding, i don't want it to start with a syllabus and a robot voice explaining variables like she is in school. I want her to be able to open a terminal, be in a real folder, point at a real thing that feels weird, and have something there that can actually look with her.

Something that says, okay, let's see what changed. Let's read the file. Let's fix one thing. Let's run it. Here's what the diff means.

Not in a fake sweet way. Not in a lecture way. Just there.

This repo is that little place.

It is a local CLI built on top of the Pi SDK. It runs in whatever project folder you open it from, saves chats locally, can read and edit files, can run checks, and has a Cara-specific behavior layer so the interaction feels like a workshop instead of a classroom.

The whole point is that she can learn from the outside in by touching the real thing.

## Why

Because Cara is new to this, but she is not helpless.

And i don't want the tool to treat her like she is helpless.

I want it to keep the steps small enough that she can stay with it, but real enough that it still counts. If something is broken, the agent should inspect the actual code. If a word shows up that she doesn't know, it should explain that word in the context of the thing she is already doing. If a fix happens, she should get to understand what changed instead of just watching magic happen.

The loop i care about is simple:

- she notices something feels off
- she says it in normal words
- the agent checks the real files
- it explains only the next useful thing
- it makes the smallest serious fix
- it runs or names the check
- it explains the diff
- she leaves knowing a little more than before

That is it. That is the experience.

Not a course. Not a chatbot pretending to be a teacher. A small workshop she can keep coming back to.

The voice matters, but mostly because it protects that loop. It should be warm without getting corny, serious when it is code, chill when it is just chat, and honest enough to say when something is risky or confusing.

Mostly i want it to feel like this:

> we can look at the real thing together, and you don't have to already know how to say it perfectly.

## How it is built

This is the shape of the thing, built simple so the shape stays readable.

The CLI is the body. The prompt files are the manners. The local sessions are the memory of where the conversation left off. Pi is the engine underneath it.

- `src/` is the terminal app: input, status line, slash commands, file mentions, session handling, and Pi SDK wiring.
- `prompts/cara-workshop-guide.md` is the main guide for how the agent should teach, fix, pause, explain, and not overdo it.
- `AGENTS.md` keeps the project rules that should survive across chats: voice, memory, live adaptation, and engineering habits.
- `commands/` is where repeated workflows can become slash commands, but only after they earn it.
- `cara.ps1` and `cara.cmd` are the local doors into the tool.

## Run it

```powershell
.\cara.ps1
```

The normal experience should be conversational. Cara should be able to type naturally:

```txt
how does chat work
where is the report button
make this page less ugly
why does this say batch
can I change this color
```

The agent should detect whether she is asking, finding, changing, debugging, or judging UI, then respond at her level. Specific commands are optional shortcuts for Elson/dev testing, not something Cara has to memorize.

## Dev commands

Use Bun for repo/package-manager tasks:

```powershell
bun run ui:dev
bun run ui:typecheck
```

The CLI runs on Node. Pi is now a normal package dependency of Cara, so it no longer needs Elson's local Pi source checkout.

## Install the terminal command

Fresh Windows install from PowerShell, once the repo or release asset is public/accessible:

```powershell
irm https://raw.githubusercontent.com/justelson/cara-agent/master/install.ps1 | iex
```

Fresh Windows install from Command Prompt (`cmd.exe`):

```cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/justelson/cara-agent/master/install.ps1 | iex"
```

That downloads Cara into:

```txt
%LOCALAPPDATA%\Cara
```

and adds the `cara` command to the user PATH.

From a local clone of this repo, install the same command with PowerShell:

```powershell
.\install.ps1
```

or with Command Prompt:

```cmd
install.cmd
```

On macOS/Linux:

```bash
bash install.sh
```

The installer checks for Node 22.19.0 or newer because the CLI runs on Node and Pi requires current Node APIs. If Node or Cara dependencies are missing, it asks before installing them. It then makes the `cara` command available and runs `cara doctor`. For package-manager actions, prefer Bun; the installer falls back to npm when Bun is not available.

For unattended installs, pass `-Yes`:

```powershell
.\install.ps1 -Yes
```

A GitHub release can now ship this repo/package without requiring a separate Pi checkout.

## Auth setup

Cara uses Pi auth under the hood, so ChatGPT/Codex credentials are stored in the same Pi auth file:

```txt
~/.pi/agent/auth.json
```

On Cara's machine, log in with her own ChatGPT Plus/Pro account:

```powershell
.\cara.ps1 login
```

Check account, plan, limits, or clear auth:

```powershell
.\cara.ps1 auth
.\cara.ps1 account
.\cara.ps1 codexusage
.\cara.ps1 logout
```

Inside an interactive Cara chat, the Pi-style slash commands work too:

```txt
/auth
/account
/codexusage
/login
/logout
```

Do not copy Elson's `auth.json` to Cara's machine. Let her log in so the tokens belong to her account.

## Optional one-off commands

These are useful for Elson, testing, and repeat workflows. They are not required for normal use.

```powershell
.\cara.ps1 inspect
.\cara.ps1 ask "Explain this error simply"
.\cara.ps1 -p "Explain this error simply"
.\cara.ps1 --project "C:\path\to\repo"
.\cara.ps1 auth
.\cara.ps1 account
.\cara.ps1 codexusage
.\cara.ps1 login
.\cara.ps1 logout
.\cara.ps1 sessions
.\cara.ps1 continue
.\cara.ps1 resume
.\cara.ps1 resume 019dd97b
.\cara.ps1 doctor
```

## Inside chat

Type `/commands` to see what is available.

The useful ones are:

- `@file` to attach a project file to the prompt
- `/start` to scan the current repo and give a plain starting point
- `/status` to see project/session/model info
- `/profile` to see or switch whether this is Elson/build mode or Cara/use mode
- `/auth` or `/account` to show logged-in email, plan, token status, and Codex limits
- `/login`, `/logout` to manage ChatGPT/Codex auth like Pi
- `/codexusage` to show only current Codex quota usage and reset times
- `/memory` to summarize what the agent knows about Cara
- `/consolidate` to clean up local memory after meaningful sessions
- `/thinking` and `/models` to adjust runtime behavior
- `/sessions`, `continue`, and `resume` to come back to saved local chats
- `/reload` to restart Cara from disk and resume the chat after code/resource edits
- `/reload --soft` after editing custom commands, themes, prompts, or memory when you do not need a process restart
- `/exit` or `/quit` when done

## Commands should earn their place

I don't want this repo full of random starter slash commands just to look capable.

If Cara keeps doing the same workflow over and over, then yeah, save it as a command:

- `commands/<name>.md` for global Cara CLI commands
- `<project>/.cara/commands/<name>.md` for project-local commands

Then run `/reload`.

The tool should grow from real use, not from pretending we already know every workflow she will need.
