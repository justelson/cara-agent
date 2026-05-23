#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "zyra.mjs");

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    ZYRA_CALLER_CWD: process.env.ZYRA_CALLER_CWD ?? process.cwd(),
    CARA_CALLER_CWD: process.env.CARA_CALLER_CWD ?? process.env.ZYRA_CALLER_CWD ?? process.cwd(),
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
