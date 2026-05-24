import { redactSecrets } from "./zyra-memory-prompts.mjs";

export function parseMemoryWorkerJson(text, requiredKeys = []) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Memory worker returned an empty response.");
  const candidates = [];
  candidates.push(raw);
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidates.push(fence[1].trim());
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  let parsed;
  let lastError;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Memory worker returned invalid JSON: ${lastError?.message ?? "not an object"}`);
  }
  for (const key of requiredKeys) {
    if (!(key in parsed)) throw new Error(`Memory worker JSON missing key: ${key}`);
  }
  return parsed;
}

export function normalizeStage1WorkerOutput(output) {
  const rolloutSummary = redactSecrets(output?.rollout_summary ?? output?.rolloutSummary ?? "").trim();
  const rolloutSlug = sanitizeSlug(output?.rollout_slug ?? output?.rolloutSlug ?? rolloutSummary).slice(0, 80);
  const rawMemory = redactSecrets(output?.raw_memory ?? output?.rawMemory ?? "").trim();
  return {
    rolloutSummary,
    rolloutSlug,
    rawMemory,
    isEmpty: !rolloutSummary || !rawMemory,
  };
}

function sanitizeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
