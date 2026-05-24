import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { redactSecrets } from "./zyra-memory-prompts.mjs";

export function createMemoryPhase2Path(deps) {
  return {
    writePhase2WorkerOutput(root, output) {
      deps.ensureMemoryWorkspace(root);
      const paths = deps.getMemoryPaths(root);
      const memorySummary = redactSecrets(output?.memory_summary ?? output?.memorySummary ?? "").trim();
      const memoryHandbook = redactSecrets(output?.memory_handbook ?? output?.memoryHandbook ?? "").trim();
      const skillPlan = normalizePhase2SkillPlan(paths, output);
      if (!memorySummary.startsWith("v1\n") && memorySummary !== "v1") {
        throw new Error("Phase-2 memory_summary must start with exactly `v1`.");
      }
      if (!memoryHandbook.startsWith("#")) {
        throw new Error("Phase-2 memory_handbook must be markdown with a heading.");
      }
      writeFileSync(paths.summary, `${memorySummary}\n`, "utf8");
      writeFileSync(paths.handbook, `${memoryHandbook}\n`, "utf8");
      applyPhase2SkillPlan(skillPlan);
      const selectedOutputs = deps.rebuildPhase2Inputs(root);
      return {
        summaryPath: paths.summary,
        handbookPath: paths.handbook,
        skillsWritten: skillPlan.writes.length,
        skillsDeleted: skillPlan.deletes.length,
        selectedOutputs,
      };
    },
  };
}

function normalizePhase2SkillPlan(paths, output) {
  const writes = [];
  const deletes = [];
  const rawSkills = Array.isArray(output?.skills) ? output.skills : [];
  const rawDeletes = Array.isArray(output?.delete_skills)
    ? output.delete_skills
    : Array.isArray(output?.deleteSkills) ? output.deleteSkills : [];

  for (const rawName of rawDeletes) {
    const name = normalizeSkillName(rawName);
    const skillDir = path.join(paths.skills, name);
    assertInsidePath(paths.skills, skillDir, "skill delete");
    deletes.push({ name, dir: skillDir });
  }

  for (const item of rawSkills) {
    const name = normalizeSkillName(item?.name ?? item?.skill_name ?? item?.skillName);
    const skillDir = path.join(paths.skills, name);
    assertInsidePath(paths.skills, skillDir, "skill write");
    const skillMd = redactSecrets(item?.skill_md ?? item?.skillMd ?? item?.content ?? "").trim();
    if (!skillMd.startsWith("---")) {
      throw new Error(`Skill ${name} must include SKILL.md YAML frontmatter.`);
    }
    const files = [{
      path: path.join(skillDir, "SKILL.md"),
      content: `${skillMd}\n`,
    }];
    for (const file of Array.isArray(item?.files) ? item.files : []) {
      const relativePath = normalizeSkillFilePath(file?.path ?? file?.relativePath);
      if (relativePath.toLowerCase() === "skill.md") {
        throw new Error(`Skill ${name} files must not overwrite SKILL.md; use skill_md.`);
      }
      const target = path.join(skillDir, relativePath);
      assertInsidePath(skillDir, target, "skill support file");
      files.push({
        path: target,
        content: `${redactSecrets(file?.content ?? "").trim()}\n`,
      });
    }
    writes.push({ name, dir: skillDir, files });
  }

  return { skillsRoot: paths.skills, writes, deletes };
}

function applyPhase2SkillPlan(plan) {
  for (const item of plan.deletes) {
    assertInsidePath(plan.skillsRoot, item.dir, "skill delete");
    rmSync(item.dir, { recursive: true, force: true });
  }
  for (const item of plan.writes) {
    assertInsidePath(plan.skillsRoot, item.dir, "skill write");
    rmSync(item.dir, { recursive: true, force: true });
    mkdirSync(item.dir, { recursive: true });
    for (const file of item.files) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, "utf8");
    }
  }
}

function normalizeSkillName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`Invalid memory skill name: ${value}`);
  }
  return name;
}

function normalizeSkillFilePath(value) {
  const relative = String(value ?? "").replaceAll("\\", "/").trim();
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("..") ||
    !/^(scripts|templates|examples)\/[a-zA-Z0-9_.\/-]+$/.test(relative)
  ) {
    throw new Error(`Invalid memory skill support file path: ${value}`);
  }
  return relative;
}

function assertInsidePath(parent, target, label) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  const relative = path.relative(parentPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing ${label} outside expected parent: ${target}`);
  }
}
