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
 *
 * The ops-agent and transitous-runner images copy only the packages they use,
 * so a package changing elsewhere does not rebuild them. Their installs must
 * stage their manifest closure. For a tsx image, every repository file its
 * runtime code imports must be copied into the runner: the import graph below
 * is followed from its entry points with the image's own module resolution.
 *
 * A bundled image runs a bundle of its code instead (scripts/
 * build-runtime-bundles.mjs). Its bundle must build, its runner must not copy
 * workspace source, and the planner relies on the runner reaching the stage
 * named `bundle`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeBundle, RUNTIME_BUNDLES } from "./build-runtime-bundles.mjs";
import { coversPath, dockerInputs, dockerStages, stageInputs } from "./docker-inputs.mjs";
import { runtimeImportGraph } from "./runtime-import-graph";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");
const readJson = (rel: string): { name?: string; dependencies?: Record<string, string> } =>
  JSON.parse(read(rel));

function runnerSection(relPath: string): string {
  const content = read(relPath);
  const runnerIdx = content.search(/^FROM\s+\S+\s+AS\s+runner\s*$/im);
  if (runnerIdx === -1) {
    throw new Error(`${relPath}: could not find a "FROM ... AS runner" stage`);
  }
  return content.slice(runnerIdx);
}

const ALL_PACKAGES = readdirSync(join(ROOT, "packages"));

/**
 * The `packages/<name>` directories a set of Dockerfile instructions copies
 * from the build context, read with the release planner's COPY parser (which
 * understands flags, `--parents`, multiple sources and globs). A copy of the
 * whole `packages/` directory, or syntax the parser widens to the context,
 * counts as every package.
 */
function copiedPackages(instructions: string, file: (name: string) => string): Set<string> {
  const pkgs = new Set<string>();
  for (const input of dockerInputs(instructions, ".") as string[]) {
    if (input === "." || input === "packages") {
      for (const name of ALL_PACKAGES) pkgs.add(name);
      continue;
    }
    for (const name of ALL_PACKAGES) {
      if (coversPath([input], `packages/${name}/${file(name)}`)) pkgs.add(name);
    }
  }
  return pkgs;
}

/**
 * The `packages/<name>` source directories a Dockerfile's `runner` stage bakes
 * in (source copies, not `--from=` node_modules copies).
 */
function runnerPackages(relPath: string): Set<string> {
  return copiedPackages(runnerSection(relPath), () => "src/index.ts");
}

/**
 * The `packages/<name>` set a Dockerfile stages a `package.json` for. These are
 * what `pnpm install --frozen-lockfile` needs present to resolve the workspace
 * link; without one the install fails outright, before any runtime concern.
 */
function manifestPackages(relPath: string): Set<string> {
  return copiedPackages(read(relPath), () => "package.json");
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
  {
    path: "apps/ops-agent/Dockerfile",
    stagesSource: false,
    // The agent runs its fixed CLI from source, so the CLI's closure ships too.
    required: requiredPackages([
      ...Object.keys(readJson("apps/ops-agent/package.json").dependencies ?? {}),
      "@openmapx/cli",
    ]),
  },
  {
    path: "apps/transitous-runner/Dockerfile",
    stagesSource: false,
    required: requiredPackages(
      Object.keys(readJson("apps/transitous-runner/package.json").dependencies ?? {}),
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

/**
 * Images that run workspace source under tsx, with the entry points their
 * runtime starts from. Their own `src` is compiled into `dist` by the builder.
 */
const RUNTIME_IMAGES: {
  path: string;
  tsconfig: string;
  entries: string[];
  compiled: string;
  computedImports?: Record<string, string[]>;
  notShipped?: Record<string, string>;
}[] = [
  {
    path: "apps/ops-agent/Dockerfile",
    tsconfig: "apps/ops-agent/tsconfig.json",
    entries: ["apps/ops-agent/src", "packages/cli/src/index.ts"],
    compiled: "apps/ops-agent/src/",
    computedImports: {
      "apps/ops-agent/src/data-inventory.ts": ["packages/transitous-core/src/motis-config.ts"],
    },
    notShipped: {
      "integrations/transit-dynamic-registry/":
        "only `transit-registry bump` loads it, a developer command the agent never runs",
    },
  },
  {
    path: "services/data-manager/Dockerfile",
    tsconfig: "services/data-manager/tsconfig.json",
    entries: ["services/data-manager/src"],
    compiled: "services/data-manager/src/",
  },
];

for (const image of RUNTIME_IMAGES) {
  const graph = runtimeImportGraph({
    root: ROOT,
    tsconfig: image.tsconfig,
    entries: image.entries,
    computedImports: image.computedImports,
  });
  for (const file of graph.undeclaredComputedImports) {
    completenessErrors.push(
      `${file} imports a computed specifier, so the files ${image.path} must ship cannot be ` +
        "followed. Declare the files it loads in RUNTIME_IMAGES.computedImports.",
    );
  }
  for (const file of graph.staleComputedImportDeclarations) {
    completenessErrors.push(
      `${image.path}: ${file} is declared in computedImports but is unreachable or has no ` +
        "computed import any more. Remove the declaration.",
    );
  }
  for (const edge of graph.unresolved) {
    completenessErrors.push(`${image.path}: unresolvable runtime import ${edge}.`);
  }
  const copied = dockerInputs(runnerSection(image.path), ".") as string[];
  const notShipped = Object.keys(image.notShipped ?? {});
  const missing = graph.files.filter(
    (file) =>
      !file.startsWith(image.compiled) &&
      !notShipped.some((prefix) => file.startsWith(prefix)) &&
      !coversPath(copied, file),
  );
  if (missing.length > 0) {
    completenessErrors.push(
      `${image.path}'s runner never copies files its runtime code imports: ` +
        `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ""}\n` +
        "    They resolve during development and then throw ERR_MODULE_NOT_FOUND in the image. " +
        "Copy them into the runner stage.",
    );
  }
}

/** The Dockerfile of each bundled image, by bundle name. */
const BUNDLED_DOCKERFILES: Record<string, string> = {
  "transitous-runner": "apps/transitous-runner/Dockerfile",
};
const SOURCE_PREFIXES = [
  /^packages\//,
  /^apps\/[^/]+\/src(?:\/|$)/,
  /^services\/[^/]+\/src(?:\/|$)/,
  /^integrations\//,
];

async function checkBundledImages(): Promise<void> {
  const bundled = Object.keys(RUNTIME_BUNDLES).sort();
  if (JSON.stringify(Object.keys(BUNDLED_DOCKERFILES).sort()) !== JSON.stringify(bundled)) {
    completenessErrors.push(
      `BUNDLED_DOCKERFILES must name the Dockerfile of every runtime bundle: ${bundled.join(", ")}.`,
    );
  }
  for (const dockerfile of [
    "apps/api/Dockerfile",
    "apps/web/Dockerfile",
    ...Object.values(BUNDLED_DOCKERFILES),
    ...RUNTIME_IMAGES.map((image) => image.path),
  ]) {
    const hasBundleStage = dockerStages(read(dockerfile)).some((stage) => stage.name === "bundle");
    if (hasBundleStage && !Object.values(BUNDLED_DOCKERFILES).includes(dockerfile)) {
      completenessErrors.push(`${dockerfile} has a bundle stage but no runtime bundle definition.`);
    }
  }
  for (const [image, dockerfile] of Object.entries(BUNDLED_DOCKERFILES)) {
    const content = read(dockerfile);
    if (!stageInputs(content, ".", "bundle").reachesReplaced) {
      completenessErrors.push(
        `${dockerfile}: the runner must be built from a stage named "bundle".`,
      );
    }
    const copied = (dockerInputs(runnerSection(dockerfile), ".") as string[]).filter(
      (input) => input === "." || SOURCE_PREFIXES.some((prefix) => prefix.test(input)),
    );
    if (copied.length > 0) {
      completenessErrors.push(
        `${dockerfile}'s runner copies workspace source (${copied.join(", ")}); a bundled image ` +
          "runs its bundle, and the release planner does not fingerprint that source.",
      );
    }
    try {
      await buildRuntimeBundle(ROOT, image);
    } catch (error) {
      completenessErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

async function report(): Promise<void> {
  await checkBundledImages();
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
    ).join(", ")} packages staged; bundles build for ${Object.keys(RUNTIME_BUNDLES).join(", ")}.`,
  );
}

// No top-level await: this script is compiled as CommonJS.
void report();
