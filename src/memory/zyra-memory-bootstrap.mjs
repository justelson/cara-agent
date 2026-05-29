import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function createMemoryBootstrapPath(deps) {
  return {
    ensureMemoryWorkspace(root) {
      const paths = deps.getMemoryPaths(root);
      for (const dir of [
        paths.root,
        paths.stage1,
        paths.stage1Inputs,
        paths.rolloutSummaries,
        paths.skills,
        paths.adHoc,
        paths.adHocNotes,
      ]) {
        mkdirSync(dir, { recursive: true });
      }

      writeIfMissing(paths.summary, deps.defaultSummary);
      writeIfMissing(paths.handbook, deps.defaultHandbook);
      writeIfMissing(paths.rawMemories, deps.defaultRawMemories);
      writeIfMissing(paths.workspaceGitignore, deps.memoryWorkspaceGitignore);
      writeIfMissing(paths.adHocInstructions, deps.adHocInstructions);

      let state = deps.readMemoryState(root);
      state = migrateLayerFiles(root, state, deps);
      deps.writeMemoryState(root, state);
      deps.rebuildPhase2Inputs(root);
      return deps.readMemoryState(root);
    },

    ensureBareMemoryWorkspace(root) {
      const paths = deps.getMemoryPaths(root);
      for (const dir of [paths.root, paths.stage1, paths.stage1Inputs, paths.rolloutSummaries]) {
        mkdirSync(dir, { recursive: true });
      }
      writeIfMissing(paths.summary, deps.defaultSummary);
      writeIfMissing(paths.handbook, deps.defaultHandbook);
      writeIfMissing(paths.rawMemories, deps.defaultRawMemories);
      writeIfMissing(paths.state, `${JSON.stringify(deps.createEmptyMemoryState(), null, 2)}\n`);
    },
  };
}

function migrateLayerFiles(root, state, deps) {
  const paths = deps.getMemoryPaths(root);
  if (state.migrations.legacyLayersAt) return state;
  const legacy = [];
  let newest = 0;
  for (const file of deps.layerFiles) {
    const fullPath = path.join(paths.root, file);
    if (!existsSync(fullPath)) continue;
    const text = readText(fullPath).trim();
    if (!text) continue;
    const stat = statSync(fullPath);
    newest = Math.max(newest, stat.mtimeMs);
    legacy.push(`File: ${file}\n${text}`);
  }
  if (!legacy.length) {
    state.migrations.legacyLayersAt = new Date().toISOString();
    return state;
  }

  const migrated = deps.upsertStage1OutputWithoutEnsure(root, {
    threadId: "legacy-layers",
    sourcePath: paths.root,
    sourceUpdatedAt: new Date(newest || Date.now()).toISOString(),
    cwd: root,
    generatedAt: new Date().toISOString(),
    rolloutSlug: "legacy_zyra_memory_layers",
    rolloutSummary: "Migrated the old Zyra markdown memory layers into the staged memory workspace.",
    rawMemory: [
      "## Legacy Zyra Memory Layers",
      "",
      "These notes were migrated from the pre-staged `.zyra/memory/*.md` layer files.",
      "Treat them as seed memory until newer session-backed evidence replaces them.",
      "",
      legacy.join("\n\n---\n\n"),
    ].join("\n"),
    memoryMode: "enabled",
    usageCount: 0,
  });

  state.stage1Outputs[migrated.threadId] = deps.stage1Metadata(migrated);
  state.phase2.selectedThreadIds = [...new Set([...(state.phase2.selectedThreadIds ?? []), migrated.threadId])];
  state.migrations.legacyLayersAt = new Date().toISOString();
  return state;
}

function writeIfMissing(file, content) {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
