// @vitest-environment node
// Pure filesystem static-analysis guardrail — no DOM. Runs in node even though
// it lives under apps/web (the `web` Vitest project defaults to jsdom, whose
// `import.meta.url` is not a file: URL and breaks fileURLToPath below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_DIR = fileURLToPath(new URL("../../../../integrations", import.meta.url));

/**
 * `frontend.<flag>` in a manifest makes the host lazily `import()` a matching
 * module. A missing file is invisible to tsc, the bundler and the test suite —
 * it only surfaces as a rejected dynamic import that React `lazy` rethrows at
 * render time, taking the page with it. Assert the files exist.
 */
const REQUIRED_FILES: Array<{ flag: "mapLayer" | "legend" | "panel"; basename: string }> = [
  { flag: "mapLayer", basename: "map-layer" },
  { flag: "legend", basename: "legend" },
  { flag: "panel", basename: "panel" },
];

interface Manifest {
  frontend?: Record<string, unknown>;
}

function readManifest(dir: string): Manifest | null {
  const manifestPath = path.join(INTEGRATIONS_DIR, dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function modulePath(dir: string, basename: string): string | null {
  for (const ext of [".tsx", ".ts"]) {
    const full = path.join(INTEGRATIONS_DIR, dir, `${basename}${ext}`);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * The hosts resolve a component as `mod.default ?? first function-valued
 * export`, so a module that exists but exports nothing renders `undefined` and
 * crashes exactly like a missing file. This is a static approximation — it
 * cannot tell a function export from a constant — but it catches empty and
 * stub modules, which is the realistic failure.
 */
function exportsSomething(file: string): boolean {
  return /^\s*export\s/m.test(fs.readFileSync(file, "utf8"));
}

describe("integration frontend modules", () => {
  const dirs = fs
    .readdirSync(INTEGRATIONS_DIR)
    .filter((dir) => readManifest(dir) !== null)
    .sort();

  it("finds integration manifests to check", () => {
    // Guard against a vacuous pass if the integrations dir ever moves.
    expect(dirs.length).toBeGreaterThan(0);
  });

  it("every manifest frontend flag has the module the host will import", () => {
    const missing: string[] = [];

    for (const dir of dirs) {
      const frontend = readManifest(dir)?.frontend;
      if (!frontend) continue;

      for (const { flag, basename } of REQUIRED_FILES) {
        if (frontend[flag] !== true) continue;

        const file = modulePath(dir, basename);
        if (!file) {
          missing.push(`${dir}: frontend.${flag} is true but ${basename}.tsx is missing`);
        } else if (!exportsSomething(file)) {
          missing.push(`${dir}: ${basename} exists but exports nothing the host can render`);
        }
      }
    }

    // On failure the diff lists each manifest promising a module it doesn't
    // ship. Either add the file (re-exporting a shared component is fine) or
    // drop the flag.
    expect(missing).toEqual([]);
  });
});
