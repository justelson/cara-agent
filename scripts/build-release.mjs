#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";
const dist = path.join(root, "dist");
const zipName = `cara-v${version}.zip`;
const zipPath = path.join(dist, zipName);
const checksumPath = path.join(dist, "checksums.txt");

mkdirSync(dist, { recursive: true });

execFileSync("git", ["archive", "--format", "zip", "--output", zipPath, "HEAD"], {
  cwd: root,
  stdio: "inherit",
});

const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
writeFileSync(checksumPath, `${hash}  ${zipName}\n`);

console.log(`Built ${path.relative(root, zipPath)}`);
console.log(`Wrote ${path.relative(root, checksumPath)}`);
console.log("");
console.log("Windows one-line install after pushing this commit:");
console.log("irm https://raw.githubusercontent.com/justelson/cara-agent/master/install.ps1 | iex");
