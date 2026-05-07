# Cara's Agent

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
- `prompts/cara-level1.md` is the main guide for how the agent should teach, fix, pause, explain, and not overdo it.
- `AGENTS.md` keeps the project rules that should survive across chats: voice, memory, live adaptation, and engineering habits.
- `commands/` is where repeated workflows can become slash commands, but only after they earn it.
- `cara.ps1` and `cara.cmd` are the local doors into the tool.

## Run it

```powershell
.\cara.ps1
```

## One-off commands

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

## Inside chat

Type `/commands` to see what is available.

The useful ones are:

- `@file` to attach a project file to the prompt
- `/start` to scan the current repo and give a plain starting point
- `/status` to see project/session/model info
- `/profile` to see or switch whether this is Elson/build mode or Cara/use mode
- `/memory` to summarize what the agent knows about Cara
- `/consolidate` to clean up local memory after meaningful sessions
- `/thinking` and `/models` to adjust runtime behavior
- `/sessions`, `continue`, and `resume` to come back to saved local chats
- `/reload` after editing custom commands
- `/exit` or `/quit` when done

## Commands should earn their place

I don't want this repo full of random starter slash commands just to look capable.

If Cara keeps doing the same workflow over and over, then yeah, save it as a command:

- `commands/<name>.md` for global Cara CLI commands
- `<project>/.cara/commands/<name>.md` for project-local commands

Then run `/reload`.

The tool should grow from real use, not from pretending we already know every workflow she will need.
