import { sep } from "node:path";

// Analyze the whole graph: --workspace hides consumers such as the API's
// assembled-agent tests. Keep the existing two-service reporting scope.
export default function serviceExports(data) {
  for (const type of ["exports", "types"]) {
    data.issues[type] = Object.fromEntries(
      Object.entries(data.issues[type]).filter(([file]) => {
        // Knip issue-map keys are already relative to its selected directory.
        const path = file.split(sep).join("/");
        return path.startsWith("apps/ops-agent/") || path.startsWith("apps/transitous-runner/");
      }),
    );
    data.counters[type] = Object.values(data.issues[type]).reduce(
      (count, symbols) => count + Object.keys(symbols).length,
      0,
    );
  }
  return data;
}
