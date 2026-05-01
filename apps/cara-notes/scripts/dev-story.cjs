const { spawn } = require("node:child_process");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const children = [
  spawn(process.execPath, ["--no-warnings", "server/story-api.mjs"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(npmCommand, ["run", "dev", "--", "--port", "4536"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }),
];

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!shuttingDown && code && code !== 0) {
      shutdown(code);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
