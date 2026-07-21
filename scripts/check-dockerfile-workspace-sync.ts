/**
 * Dockerfile workspace-package sync gate: apps/api/Dockerfile and
 * services/data-manager/Dockerfile both bake `integrations/` into their
 * runtime image and dynamically import integration code at runtime (tsx),
 * so both runner stages must ship the same set of workspace `packages/*`
 * that the integration code depends on. If app-api's runner picks up a new
 * package (because some integration now imports it) and data-manager's
 * Dockerfile isn't updated to match, data-manager's baked integrations
 * silently fail to resolve at runtime — this only surfaces at boot via the
 * fatal builtin-discovery error, not at build time. This script asserts
 * data-manager's runner package set is a superset of app-api's so the drift
 * is caught in CI instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

// Packages app-api's runner bakes that data-manager legitimately does not
// need to (e.g. an app-api-only leaf package no integration depends on).
// Keep this empty unless a real, documented divergence exists.
const APP_API_ONLY_ALLOWLIST = new Set<string>([]);

/**
 * Extracts the set of `packages/<name>` source directories a Dockerfile's
 * `runner` stage bakes in, i.e. lines shaped `COPY packages/<name>/ <dest>`
 * (source copies, not `--from=` node_modules copies or package.json-only
 * copies used by the deps/builder stages).
 */
function runnerPackages(relPath: string): Set<string> {
  const content = read(relPath);
  const runnerIdx = content.search(/^FROM\s+\S+\s+AS\s+runner\s*$/im);
  if (runnerIdx === -1) {
    throw new Error(`${relPath}: could not find a "FROM ... AS runner" stage`);
  }
  const runnerSection = content.slice(runnerIdx);
  const pkgs = new Set<string>();
  const lineRegex = /^COPY\s+packages\/([a-z0-9-]+)\/\s+\S+\s*$/gm;
  for (const match of runnerSection.matchAll(lineRegex)) {
    const name = match[1];
    if (name) pkgs.add(name);
  }
  return pkgs;
}

const APP_API_DOCKERFILE = "apps/api/Dockerfile";
const DATA_MANAGER_DOCKERFILE = "services/data-manager/Dockerfile";

const appApiPackages = runnerPackages(APP_API_DOCKERFILE);
const dataManagerPackages = runnerPackages(DATA_MANAGER_DOCKERFILE);

if (appApiPackages.size === 0 || dataManagerPackages.size === 0) {
  console.error(
    `✗ Extracted zero packages from one of the Dockerfiles (app-api: ${appApiPackages.size}, ` +
      `data-manager: ${dataManagerPackages.size}) — the "AS runner" parsing regex likely no longer ` +
      "matches; fix scripts/check-dockerfile-workspace-sync.ts before trusting this gate.",
  );
  process.exit(1);
}

const missing = [...appApiPackages]
  .filter((pkg) => !dataManagerPackages.has(pkg) && !APP_API_ONLY_ALLOWLIST.has(pkg))
  .sort();

if (missing.length > 0) {
  console.error(
    `✗ ${DATA_MANAGER_DOCKERFILE}'s runner stage is missing packages baked into ` +
      `${APP_API_DOCKERFILE}'s runner stage: ${missing.join(", ")}\n` +
      "Add the matching `COPY packages/<pkg>/ ...` (+ `COPY --from=prod-deps .../node_modules ...` " +
      `if the package has runtime deps) lines to ${DATA_MANAGER_DOCKERFILE}, or — if the package is ` +
      "genuinely app-api-only — add it to APP_API_ONLY_ALLOWLIST in this script with a comment " +
      "explaining why.",
  );
  process.exit(1);
}

console.log(
  `✓ Dockerfile workspace package sets in sync — data-manager bakes ${dataManagerPackages.size} ` +
    `packages (app-api bakes ${appApiPackages.size}).`,
);
