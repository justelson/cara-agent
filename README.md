# Cara's Agent

I made this for Cara because I did not want her first real software-learning experience to feel like school, pressure, or a cold machine.

I wanted her to have a small place she could enter, even when she felt unsure, and still be treated like someone who belongs near real code.

This is a local coding companion built on top of the Pi SDK. It runs in the terminal, opens in whatever folder you are working in, and helps with the real loop of software work: notice what feels wrong, inspect the files, explain the next useful idea, make a careful fix, run a check, and understand what changed.

The point is not to teach a syllabus first. The point is to let her learn from the outside in by touching the real thing.

## Why This Exists

Cara is learning software engineering through actual projects, not abstract lessons.

So this agent is shaped around a simple belief:

> she should be allowed to learn by fixing real things, with enough warmth to keep coming back and enough seriousness to make the work real.

That means the agent should:

- read the actual files before guessing
- explain things simply without talking down to her
- keep beginner moments small and survivable
- avoid fake cheerfulness and lecture energy
- make real edits when the task is coding
- verify work with real checks when possible
- help her understand the diff before moving on
- let her just chat when that is what the moment needs

It is not supposed to be a generic tutor. It is supposed to feel like a little workshop: warm, direct, practical, and safe enough to return to.

## How I Made It

The CLI wraps the local Pi SDK and gives it a Cara-specific runtime:

- `prompts/cara-level1.md` defines the learning style and behavior contract.
- `AGENTS.md` keeps project-level rules for voice, memory, live adaptation, and engineering habits.
- `src/` holds the terminal UI, slash commands, file mentions, session handling, status line, and Pi SDK wiring.
- `.cara/memory/` is local-only layered memory for what the agent should remember about Cara and the way she learns.
- `.cara/sessions/` is local-only chat history so the tool can resume where it left off.

Private notes, exported chats, analysis artifacts, and local sessions are intentionally ignored by Git. The public repo should contain the tool and behavior shape, not private source material.

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

Useful controls:

- attach project files with `@`, for example `explain @src/App.jsx`
- use `/start` to inspect the current repo and get a project-specific starting point
- use `/status` to see the current project, model, profile, context, and session info
- use `/profile`, `/profile elson`, `/profile cara`, or `/profile auto` to show or switch the active profile
- use `/memory` to summarize what the agent knows about Cara
- use `/consolidate` after meaningful sessions to clean and update memory layers
- use `/reload` after adding or editing custom slash commands
- use `/thinking` and `/models` to adjust runtime behavior
- use `/sessions`, `continue`, or `resume` to return to saved local chats
- use `/exit`, `/quit`, `exit`, or `quit` to leave cleanly

## Memory And Commands

The CLI loads `AGENTS.md` files plus layered Cara memory from `.cara/memory`. `/memory` gives a compact summary, not a raw dump.

The active profile defaults to `elson` on Elson's Windows account and `cara` elsewhere. That does not make the voice colder or warmer; it only helps the agent understand whether the moment is builder/testing work or Cara using the tool.

Custom slash commands are meant to grow from repeated real workflows, not from starter-command clutter:

- `commands/<name>.md` for global Cara CLI commands
- `<project>/.cara/commands/<name>.md` for project-local commands

Run `/reload` after adding or editing command files.
