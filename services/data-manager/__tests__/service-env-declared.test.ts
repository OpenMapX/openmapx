import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "services/data-manager/src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

function scannedEnvironmentNames(): Set<string> {
  const names = new Set<string>();
  const regexes = [
    /\benv\.([A-Z][A-Z0-9_]*)\b/g,
    /process\.env\s*\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
    /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g,
  ];

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf-8");
    for (const regex of regexes) {
      for (const match of source.matchAll(regex)) names.add(match[1]);
    }
  }
  return names;
}

/** Screaming-snake literals in the source that are not environment variables. */
const NOT_ENV_LITERALS = new Set([
  "BUCKETS_PER_WEEK",
  "COEFFICIENT_COUNT",
  "DEFAULT_TRANSITOUS_FEEDS_OVERLAY_PATH",
  "ERR_ASSERTION",
  "UNKNOWN_TRAFFIC_SPEED_RAW",
]);

/** Read at runtime but deliberately not declared in the manifest. */
const INTENTIONALLY_UNDECLARED = new Set([
  // Set by services/data-manager/Dockerfile. Declaring it here would overwrite
  // it with an empty string and disable the production hard-fail in src/auth.ts.
  "NODE_ENV",
  // Read with ??, so an empty compose default would replace the correct
  // in-image path and break integration discovery. Dev-shell only.
  "OPENMAPX_INTEGRATIONS_DIR",
]);

/** Runtime knobs consumed by Node/tsx rather than by our own code. */
const DECLARED_WITHOUT_SOURCE_READ = new Set(["HOME", "TSX_TSCONFIG_PATH"]);

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "services/data-manager/service.json"), "utf-8"),
) as {
  container: { envFile?: unknown; environment: Record<string, string> };
};

describe("data-manager service environment contract", () => {
  it("does not pass the operator's whole .env into the container", () => {
    expect(
      manifest.container.envFile,
      "data-manager must not receive the operator's credential file",
    ).toBeUndefined();
  });

  it("declares every environment variable read by the daemon", () => {
    const scanned = scannedEnvironmentNames();
    const declared = new Set(Object.keys(manifest.container.environment));
    const missing = [...scanned].filter(
      (name) =>
        !NOT_ENV_LITERALS.has(name) && !INTENTIONALLY_UNDECLARED.has(name) && !declared.has(name),
    );

    expect(missing.sort()).toEqual([]);
  });

  it("does not keep declarations that the daemon never reads", () => {
    const scanned = scannedEnvironmentNames();
    const dead = Object.keys(manifest.container.environment).filter(
      (name) => !DECLARED_WITHOUT_SOURCE_READ.has(name) && !scanned.has(name),
    );

    expect(dead.sort()).toEqual([]);
  });
});
