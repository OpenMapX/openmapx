/**
 * Dockerfile workspace-package gate. Every image that bakes `integrations/`
 * must ship the workspace `packages/*` that integration code depends on, and
 * neither the local toolchain nor PR CI can tell you when it doesn't: `pnpm
 * build` externalises workspace deps, `check-types` and lint never look at a
 * Dockerfile, vitest aliases workspace names straight to source, and the image
 * build itself only runs on push to `main`. So an omission ships green and
 * breaks after merge.
 *
 * Every workspace package reachable from baked integration code must appear in
 * each baking Dockerfile. A package missing from the deps stage fails `pnpm
 * install --frozen-lockfile` (the lockfile's importer set cannot be satisfied);
 * one missing from a tsx runner resolves at install but throws
 * ERR_MODULE_NOT_FOUND at boot, taking down every integration that imports it.
 * Adding a workspace package is a repo-level act with obligations in every
 * baking Dockerfile, and it belongs to no single feature task.
 *
 * The data-manager image does not bake `integrations/`; it is held to its own
 * dependency closure the same way, since it runs workspace source under tsx.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");
const readJson = (rel: string): { name?: string; dependencies?: Record<string, string> } =>
  JSON.parse(read(rel));

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
 * The runtime `dependencies` of every integration: all of them are baked
 * wholesale by `COPY integrations/ integrations/`, so any workspace package one
 * of them imports must ship too.
 */
function integrationDependencies(): string[] {
  const deps: string[] = [];
  for (const dir of readdirSync(join(ROOT, "integrations"))) {
    try {
      deps.push(...Object.keys(readJson(`integrations/${dir}/package.json`).dependencies ?? {}));
    } catch {
      // Not an integration directory (or has no manifest); nothing to bake.
    }
  }
  return deps;
}

/**
 * The `packages/*` closure some code needs at runtime: its runtime
 * `dependencies`, followed transitively through those packages' own runtime
 * deps. `devDependencies` are deliberately not followed: they are absent from
 * the production install and never resolved at runtime.
 */
function requiredPackages(seeds: readonly string[]): Set<string> {
  const nameToDir = packageNameToDir();
  const queue = [...seeds];

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

const integrationClosure = requiredPackages(integrationDependencies());

/**
 * Every image checked, with the closure it must stage: the images that bake
 * `integrations/` need the integrations' closure, the data-manager image its
 * own. `stagesSource` marks the ones whose runner imports workspace code under
 * tsx and therefore needs the package *source*, not just its manifest —
 * `apps/web` does not, because Next's standalone output bundles workspace
 * packages at build time.
 */
const IMAGES: { path: string; stagesSource: boolean; required: Set<string> }[] = [
  { path: "apps/api/Dockerfile", stagesSource: true, required: integrationClosure },
  { path: "apps/web/Dockerfile", stagesSource: false, required: integrationClosure },
  {
    path: "services/data-manager/Dockerfile",
    stagesSource: true,
    required: requiredPackages(
      Object.keys(readJson("services/data-manager/package.json").dependencies ?? {}),
    ),
  },
];

const empty = IMAGES.filter((image) => image.required.size === 0);
if (empty.length > 0) {
  console.error(
    `✗ Computed an empty required-package set for ${empty.map((i) => i.path).join(", ")} — ` +
      "the manifest walk is broken; fix scripts/check-dockerfile-workspace-sync.ts before " +
      "trusting this gate.",
  );
  process.exit(1);
}

const completenessErrors: string[] = [];
for (const { path: dockerfile, stagesSource, required } of IMAGES) {
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
        "    The image's code imports it under tsx, so this resolves at install and then " +
        "throws ERR_MODULE_NOT_FOUND at boot, taking down everything that imports it. " +
        "Add `COPY packages/<pkg>/ <dest>` (plus the matching `COPY --from=prod-deps " +
        ".../node_modules ...` if the package has runtime deps).",
    );
  }
}

if (completenessErrors.length > 0) {
  console.error(
    `✗ Workspace packages an image's code reaches are missing from its build:\n\n` +
      `${completenessErrors.map((e) => `  • ${e}`).join("\n\n")}\n`,
  );
  process.exit(1);
}

console.log(
  `✓ Dockerfile workspace packages complete — ${IMAGES.map(
    (image) => `${image.path}: ${image.required.size}`,
  ).join(", ")} packages staged.`,
);
