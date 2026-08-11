const families = ["stable", "repairable", "incompatible", "toctou"];

function nextRandom(state) {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

export function makeTask(index, seed) {
  const state = nextRandom((seed + index * 2654435761) >>> 0);
  const family = families[index % families.length];
  const initialValue = `safe-${seed}-${index}`;
  const initial = { status: "active", value: initialValue, revision: "v1" };
  const mutation = family === "repairable"
    ? { status: "active", value: `${initialValue}-updated`, revision: "v2" }
    : family === "incompatible"
      ? { status: "blocked", value: "do-not-apply", revision: "v2" }
      : { ...initial, revision: family === "toctou" ? "v2" : "v1" };
  return {
    taskId: `task-${seed}-${String(index + 1).padStart(4, "0")}`,
    index,
    family,
    initial,
    mutation,
    mutationWindow: family === "stable" ? "none" : family === "toctou" ? "during-write" : "before-action",
    cacheAge: state % 10,
    source: "filesystem:config.json"
  };
}

export function makeTasks(count, seed) {
  return Array.from({ length: count }, (_, index) => makeTask(index, seed));
}

export const scenarioFamilies = families;
