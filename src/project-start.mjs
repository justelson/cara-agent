import path from "node:path";

export function buildProjectStartPrompt(runtime = {}, focus = "") {
  const project = path.resolve(runtime.project ?? process.cwd());
  const focusText = String(focus ?? "").trim();

  return `You are generating /start for the current project.

Current project:
${project}

First inspect the actual repo enough to make the answer specific. Read the project files that reveal what this repo does and how it is shaped: AGENTS.md, package manifests, README/docs, main source folders, route/app entry files, command handlers, config, and any obvious feature files. Do not answer from this prompt alone.

For the project name, prefer the product identity from AGENTS.md and the folder name. Use package.json only when it clearly matches the product. Use README titles only when they are not generic or stale. Do not pick implementation names like "Pi CLI", "Builder CLI", "App", or "Client" if the repo guidance names the actual product more clearly.

${focusText ? `User focus:\n${focusText}\n\n` : ""}During inspection, do not send visible progress notes or narration. The UI will show progress. After inspection, reply with only the /start output. No preface, no analysis, no markdown fence.

Use this exact shape:

[Project name]

[One sentence: what this project lets the person using it do. Not what it is technically.]

[3-5 lines. Each line describes something real that happens in this project, in plain English. Each line must reference a real behavior, feature, screen, command, workflow, or file group from this repo. Mention files briefly at the end of the line when useful. Group files by function, not by name. If files are not relevant to what the person would touch, drop the files.]

[Two closing lines. First: invite them to say what they want to do. Second: confirm we go straight to that part together.]

Rules:
- No category labels or headers.
- No technical vocabulary unless unavoidable.
- Files serve the description, never the other way around.
- Use "we", not "I".
- Keep the whole thing under 12 lines no matter how large the codebase is.
- If the codebase is large, bucket more files per line, do not add more lines.
- Do not make this about Cara's Agent unless the current project actually is Cara's Agent.
- Do not write a beginner lesson. Write like the person is here to fix, add, change, build, or understand something.`;
}
