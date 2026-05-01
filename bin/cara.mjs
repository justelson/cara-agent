#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = path.resolve(root, "..", "..", "play projects", "pi");
const tsx = path.join(piRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(root, "src", "cara.mjs");

const result = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    CARA_CALLER_CWD: process.cwd(),
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
