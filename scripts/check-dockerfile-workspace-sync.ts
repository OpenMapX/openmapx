/**
 * Dockerfile workspace-package gate. Every image that bakes `integrations/`
 * must ship the workspace `packages/*` that integration code depends on, and
 * neither the local toolchain nor PR CI can tell you when it doesn't: `pnpm
 * build` externalises workspace deps, `check-types` and lint never look at a
 * Dockerfile, vitest aliases workspace names straight to source, and the image
 * build itself only runs on push to `main`. So an omission ships green and
 * breaks after merge.
 *
 * Two independent properties are asserted here, because each catches a failure
 * the other cannot:
 *
 * 1. COMPLETENESS — every workspace package reachable from baked integration
 *    code must appear in each Dockerfile. A package missing from the deps stage
 *    fails `pnpm install --frozen-lockfile` (the lockfile's importer set cannot
 *    be satisfied); one missing from a tsx runner resolves at install but throws
 *    ERR_MODULE_NOT_FOUND at boot, taking down every integration that imports
 *    it. This is the check that a new workspace package needs: adding one is a
 *    repo-level act with obligations in three Dockerfiles, and it belongs to no
 *    single feature task.
 *
 * 2. DRIFT — data-manager's runner must remain a superset of app-api's. Both
 *    dynamically import baked integration code under tsx, so a package app-api
 *    picks up must reach data-manager too or its integrations fail at boot.
 *
 * Property 2 alone is satisfied by two Dockerfiles that are consistently wrong:
 * a package omitted from both leaves the sets in sync and the gate green. That
 * is exactly how `packages/brands` shipped missing from all three Dockerfiles.
 * Property 1 is what closes it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");
const readJson = (rel: string): { name?: string; dependencies?: Record<string, string> } =>
  JSON.parse(read(rel));

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

/**
 * Extracts the `packages/<name>` set a Dockerfile stages a `package.json` for,
 * i.e. lines shaped `COPY packages/<name>/package.json <dest>`. These are what
 * `pnpm install --frozen-lockfile` needs present to resolve the workspace link;
 * without one the install fails outright, before any runtime concern.
 */
function manifestPackages(relPath: string): Set<string> {
  const pkgs = new Set<string>();
  const lineRegex = /^COPY\s+packages\/([a-z0-9-]+)\/package\.json\s+\S+\s*$/gm;
  for (const match of read(relPath).matchAll(lineRegex)) {
    const name = match[1];
    if (name) pkgs.add(name);
  }
  return pkgs;
}

/** Maps workspace package name (`@openmapx/core`) to its directory (`core`). */
function packageNameToDir(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    let name: string | undefined;
    try {
      name = readJson(`packages/${dir}/package.json`).name;
    } catch {
      continue; // not a package directory
    }
    if (name) map.set(name, dir);
  }
  return map;
}

/**
 * The `packages/*` closure that baked integration code needs at runtime.
 *
 * Seeded from every integration's runtime `dependencies` — all of them are baked
 * wholesale by `COPY integrations/ integrations/`, so any workspace package one
 * of them imports must ship too — then followed transitively through those
 * packages' own runtime deps. `devDependencies` are deliberately not followed:
 * they are absent from the production install and never resolved at runtime.
 */
function requiredPackages(): Set<string> {
  const nameToDir = packageNameToDir();
  const queue: string[] = [];

  for (const dir of readdirSync(join(ROOT, "integrations"))) {
    try {
      queue.push(...Object.keys(readJson(`integrations/${dir}/package.json`).dependencies ?? {}));
    } catch {
      // Not an integration directory (or has no manifest); nothing to bake.
    }
  }

  const required = new Set<string>();
  while (queue.length > 0) {
    const dep = queue.pop();
    if (!dep) continue;
    const dir = nameToDir.get(dep);
    // Non-workspace deps and integration-to-integration deps are not
    // `packages/*` and need no COPY line of their own.
    if (!dir || required.has(dir)) continue;
    required.add(dir);
    queue.push(...Object.keys(readJson(`packages/${dir}/package.json`).dependencies ?? {}));
  }
  return required;
}

const APP_API_DOCKERFILE = "apps/api/Dockerfile";
const DATA_MANAGER_DOCKERFILE = "services/data-manager/Dockerfile";
const WEB_DOCKERFILE = "apps/web/Dockerfile";

/**
 * Every image that bakes `integrations/`. `stagesSource` marks the ones whose
 * runner dynamically imports integration code under tsx and therefore needs the
 * package *source*, not just its manifest — `apps/web` does not, because Next's
 * standalone output bundles workspace packages at build time.
 */
const BAKING_IMAGES: { path: string; stagesSource: boolean }[] = [
  { path: APP_API_DOCKERFILE, stagesSource: true },
  { path: DATA_MANAGER_DOCKERFILE, stagesSource: true },
  { path: WEB_DOCKERFILE, stagesSource: false },
];

const required = requiredPackages();

if (required.size === 0) {
  console.error(
    "✗ Computed an empty required-package set from integrations/ — the manifest walk is " +
      "broken; fix scripts/check-dockerfile-workspace-sync.ts before trusting this gate.",
  );
  process.exit(1);
}

const completenessErrors: string[] = [];
for (const { path: dockerfile, stagesSource } of BAKING_IMAGES) {
  const manifests = manifestPackages(dockerfile);
  const missingManifests = [...required].filter((pkg) => !manifests.has(pkg)).sort();
  if (missingManifests.length > 0) {
    completenessErrors.push(
      `${dockerfile} never stages package.json for: ${missingManifests.join(", ")}\n` +
        "    `pnpm install --frozen-lockfile` cannot satisfy the workspace link without it — " +
        "the image build fails. Add `COPY packages/<pkg>/package.json packages/<pkg>/` to every " +
        "stage that installs.",
    );
  }

  if (!stagesSource) continue;
  const sources = runnerPackages(dockerfile);
  const missingSources = [...required].filter((pkg) => !sources.has(pkg)).sort();
  if (missingSources.length > 0) {
    completenessErrors.push(
      `${dockerfile}'s runner never copies source for: ${missingSources.join(", ")}\n` +
        "    Baked integration code imports it under tsx, so this resolves at install and then " +
        "throws ERR_MODULE_NOT_FOUND at boot, taking down every integration that imports it. " +
        "Add `COPY packages/<pkg>/ <dest>` (plus the matching `COPY --from=prod-deps " +
        ".../node_modules ...` if the package has runtime deps).",
    );
  }
}

if (completenessErrors.length > 0) {
  console.error(
    `✗ Workspace packages reachable from baked integrations are missing from image builds:\n\n` +
      `${completenessErrors.map((e) => `  • ${e}`).join("\n\n")}\n`,
  );
  process.exit(1);
}

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
  `✓ Dockerfile workspace packages complete and in sync — ${required.size} packages reachable ` +
    `from baked integrations are staged by all ${BAKING_IMAGES.length} images; data-manager's ` +
    `runner bakes ${dataManagerPackages.size} (app-api bakes ${appApiPackages.size}).`,
);
