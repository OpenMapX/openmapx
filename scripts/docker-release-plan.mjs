// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone GitHub Actions script, never cached by Turbo.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePrivacySourceFingerprint } from "../apps/api/privacy-source-fingerprint.mjs";
import { coversPath, dockerInputs, stageInputs } from "./docker-inputs.mjs";

export { coversPath, dockerInputs };

export const targets = [
  { app: "api", context: ".", dockerfile: "apps/api/Dockerfile" },
  { app: "web", context: ".", dockerfile: "apps/web/Dockerfile" },
  { app: "data-manager", context: ".", dockerfile: "services/data-manager/Dockerfile" },
  { app: "ops-agent", context: ".", dockerfile: "apps/ops-agent/Dockerfile" },
  {
    app: "privacy-backup",
    context: ".",
    dockerfile: "services/ops-agent/privacy-backup/Dockerfile",
  },
  { app: "transitous-runner", context: ".", dockerfile: "apps/transitous-runner/Dockerfile" },
  {
    app: "transitous-tools",
    context: "services/motis/tools/transitous",
    dockerfile: "services/motis/tools/transitous/Dockerfile",
  },
];
export const pullRequestTargets = [
  ...targets,
  { app: "docs", context: "docs", dockerfile: "docs/Dockerfile" },
];
const shaPattern = /^[a-f0-9]{40}$/;
const releasePattern = /^[a-f0-9]{40}(?:-[1-9][0-9]*(?:-[1-9][0-9]*)?)?$/;
const previousReleasePattern = /^[a-f0-9]{40}(?:-[1-9][0-9]*(?:-[1-9][0-9]*)?)?$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxColdRefreshAge = 7 * 24 * 60 * 60 * 1000;
// ci.yml only calls docker.yml and passes it nothing; the build itself is
// defined by docker.yml, and what counts as an input by the planner's code.
const globalInputs = [
  ".github/workflows/docker.yml",
  "scripts/docker-release-plan.mjs",
  "scripts/docker-inputs.mjs",
];
const LOCKFILE = "pnpm-lock.yaml";

export function targetInputs(
  target,
  readDockerfile,
  sources = dockerInputs(readDockerfile(target.dockerfile), target.context),
) {
  return [
    ...sources,
    target.dockerfile,
    posix.join(target.context, ".dockerignore"),
    `${target.dockerfile}.dockerignore`,
    ...globalInputs,
    ...(target.app === "docs" ? [".github/workflows/docs.yml", ".trivyignore.yaml", ".nvmrc"] : []),
  ];
}

export function selectChangedTargets({
  changedPaths,
  readDockerfile,
  tree = [],
  candidates = pullRequestTargets,
}) {
  return candidates
    .filter((target) => {
      const inputs = targetInputs(target, readDockerfile);
      const copiedSymlink = tree.some(
        (entry) => entry.mode === "120000" && coversPath(inputs, entry.path),
      );
      return changedPaths.some((path) => copiedSymlink || coversPath(inputs, path));
    })
    .map((target) => target.app);
}

export function trackedTree(root) {
  return execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, , oid] = entry.slice(0, tab).split(" ");
      return { path: entry.slice(tab + 1), mode, oid };
    });
}

/** Lockfile key of a resolved dependency: aliases record the target package. */
function snapshotKey(name, version) {
  return version.replace(/\(.*$/, "").includes("@") ? version : `${name}@${version}`;
}

/**
 * The part of a pnpm v9 lockfile an image installs: the importers whose
 * package.json it copies, the workspace importers they link, every snapshot and
 * package reachable from them, and all settings outside those maps. Throws when
 * anything it follows is missing, so callers can fall back to the whole file.
 */
export function lockfileSubgraph(
  documents,
  selectsImporter,
  sections = ["dependencies", "devDependencies", "optionalDependencies"],
) {
  // pnpm 11+ writes its own environment as a first document; the workspace
  // document is the one listing the workspace importers.
  const main = documents
    .filter((document) => document?.importers && document?.snapshots && document?.packages)
    .sort((a, b) => Object.keys(b.importers).length - Object.keys(a.importers).length)[0];
  if (!main) throw new Error("Unrecognized lockfile");
  const others = documents.filter((document) => document !== main);
  const header = Object.fromEntries(
    Object.entries(main).filter(([key]) => !["importers", "packages", "snapshots"].includes(key)),
  );
  const importers = new Map();
  const snapshots = new Map();
  const packages = new Map();
  const importerQueue = Object.keys(main.importers).filter(selectsImporter);
  const snapshotQueue = [];
  while (importerQueue.length > 0) {
    const key = importerQueue.pop();
    if (importers.has(key)) continue;
    const importer = main.importers[key];
    if (!importer || typeof importer !== "object") throw new Error(`Missing importer ${key}`);
    importers.set(key, importer);
    for (const section of sections) {
      for (const [name, dependency] of Object.entries(importer[section] ?? {})) {
        const version = typeof dependency === "object" ? dependency?.version : dependency;
        if (typeof version !== "string") throw new Error(`Unresolved ${name} in ${key}`);
        if (version.startsWith("link:")) {
          importerQueue.push(posix.normalize(posix.join(key, version.slice(5))));
        } else snapshotQueue.push(snapshotKey(name, version));
      }
    }
  }
  while (snapshotQueue.length > 0) {
    const key = snapshotQueue.pop();
    if (snapshots.has(key)) continue;
    if (!Object.hasOwn(main.snapshots ?? {}, key)) throw new Error(`Missing snapshot ${key}`);
    const snapshot = main.snapshots[key] ?? {};
    snapshots.set(key, snapshot);
    const packageKey = key.replace(/\(.*$/, "");
    if (!Object.hasOwn(main.packages ?? {}, packageKey)) {
      throw new Error(`Missing package ${packageKey}`);
    }
    packages.set(packageKey, main.packages[packageKey]);
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
        if (typeof version !== "string") throw new Error(`Unresolved ${name} in ${key}`);
        if (!version.startsWith("link:")) snapshotQueue.push(snapshotKey(name, version));
      }
    }
  }
  const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify([
        "openmapx/lockfile-subgraph/v1",
        others,
        header,
        sorted(importers),
        sorted(snapshots),
        sorted(packages),
      ]),
    )
    .digest("hex");
}

// What a production install reads from a manifest. Scripts, versions and
// development dependencies do not change the installed packages.
const ROOT_INSTALL_FIELDS = [
  "packageManager",
  "pnpm",
  "dependencies",
  "optionalDependencies",
  "resolutions",
  "engines",
];
const WORKSPACE_INSTALL_FIELDS = [
  "name",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "dependenciesMeta",
  "bin",
];

function installProjection(path, text) {
  const manifest = JSON.parse(text);
  const fields = path === "package.json" ? ROOT_INSTALL_FIELDS : WORKSPACE_INSTALL_FIELDS;
  return JSON.stringify(fields.map((field) => [field, manifest[field] ?? null]));
}

/**
 * An image's input fingerprint. A bundled image (one built from a `bundle`
 * stage) is fingerprinted by its bundle digest instead of by the stages that
 * only feed the bundle; what its production install reads from the manifests
 * and lockfile stands in for those files.
 */
export function imageFingerprint({
  target,
  tree,
  readDockerfile,
  privacyFingerprint,
  lockfile,
  onLockfileFallback = () => {},
  bundleDigest,
  readFile,
}) {
  const dockerfile = readDockerfile(target.dockerfile);
  let inputs;
  if (bundleDigest) {
    const staged = stageInputs(dockerfile, target.context, "bundle");
    if (!staged.reachesReplaced) throw new Error(`${target.app}: no stage named "bundle" is used`);
    if (typeof readFile !== "function") throw new Error("A bundled image needs file contents");
    inputs = targetInputs(target, readDockerfile, staged.inputs);
  } else inputs = targetInputs(target, readDockerfile);
  let entries = tree.filter((entry) => coversPath(inputs, entry.path));
  // A copied symlink may resolve to another tracked path. Include the whole tree
  // rather than guessing which side of a Docker COPY dereferences it.
  if (entries.some((entry) => entry.mode === "120000")) entries = tree;
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      bundleDigest ? "openmapx/docker-inputs/v3-bundle" : "openmapx/docker-inputs/v2",
      target,
      "linux/amd64",
      dockerfile,
    ]),
  );
  if (bundleDigest) hash.update(JSON.stringify(["bundle", bundleDigest]));
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (bundleDigest && (entry.path === "package.json" || entry.path.endsWith("/package.json"))) {
      try {
        const projection = installProjection(entry.path, readFile(entry.path));
        hash.update(JSON.stringify([entry.path, entry.mode, "install", projection]));
        continue;
      } catch {
        // An unreadable manifest counts as a whole file.
      }
    }
    // The installed dependencies depend on the lockfile entries this image's
    // copied manifests reach, not on unrelated workspace dependency changes.
    // A bundled image's runner holds only the production install.
    if (entry.path === LOCKFILE && lockfile) {
      try {
        const subgraph = lockfileSubgraph(
          lockfile.documents,
          (importer) =>
            coversPath(inputs, importer === "." ? "package.json" : `${importer}/package.json`),
          bundleDigest ? ["dependencies", "optionalDependencies"] : undefined,
        );
        hash.update(JSON.stringify([entry.path, entry.mode, "subgraph", subgraph]));
        continue;
      } catch (error) {
        onLockfileFallback(target.app, error);
      }
    }
    hash.update(JSON.stringify([entry.path, entry.mode, entry.oid]));
  }
  if (target.app === "api") hash.update(privacyFingerprint);
  return hash.digest("hex");
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Invalid image build timestamp");
  return Date.parse(value);
}

function validatePrevious(previous, imagePrefix) {
  if (!previous) return;
  if (
    previous.schemaVersion !== 1 ||
    !previousReleasePattern.test(previous.release ?? "") ||
    !hashPattern.test(previous.privacyReleaseValidation?.sourceBuildFingerprint ?? "")
  )
    throw new Error("Invalid previous release manifest");
  for (const { app } of targets) {
    const ref = previous.images?.[app];
    const prefix = `${imagePrefix}/${app}@`;
    if (
      typeof ref !== "string" ||
      !ref.startsWith(prefix) ||
      !digestPattern.test(ref.slice(prefix.length))
    )
      throw new Error(`Invalid previous release image: ${app}`);
  }
  if (previous.buildMetadata?.version !== 1) return;
  for (const { app } of targets) {
    const metadata = previous.buildMetadata.images?.[app];
    if (
      !metadata ||
      !hashPattern.test(metadata.inputHash ?? "") ||
      !shaPattern.test(metadata.sourceRevision ?? "")
    )
      throw new Error(`Invalid previous build metadata: ${app}`);
    timestamp(metadata.builtAt);
    // Legacy manifests lack this field; their next release must cold-build.
    if (metadata.coldRefreshedAt !== undefined) timestamp(metadata.coldRefreshedAt);
  }
}

export function createReleasePlan({
  revision,
  releaseId = revision,
  tree,
  readDockerfile,
  privacyFingerprint,
  previous = null,
  now = new Date().toISOString(),
  force = false,
  imagePrefix = "ghcr.io/openmapx",
  lockfile,
  onLockfileFallback,
  bundleDigests = {},
  readFile,
}) {
  if (
    !shaPattern.test(revision) ||
    !releasePattern.test(releaseId) ||
    releaseId.slice(0, 40) !== revision ||
    !hashPattern.test(privacyFingerprint)
  )
    throw new Error("Invalid release revision or privacy fingerprint");
  const currentTime = timestamp(now);
  validatePrevious(previous, imagePrefix);
  const buildMetadata = { version: 1, images: {} };
  const images = targets.map((target) => {
    const inputHash = imageFingerprint({
      target,
      tree,
      readDockerfile,
      privacyFingerprint,
      lockfile,
      onLockfileFallback,
      bundleDigest: bundleDigests[target.app],
      readFile,
    });
    const old =
      previous?.buildMetadata?.version === 1
        ? previous.buildMetadata.images[target.app]
        : undefined;
    const refresh =
      force ||
      !old ||
      old.coldRefreshedAt === undefined ||
      currentTime - timestamp(old.coldRefreshedAt) >= maxColdRefreshAge ||
      timestamp(old.coldRefreshedAt) > currentTime ||
      timestamp(old.builtAt) > currentTime;
    const privacyChanged =
      target.app === "api" &&
      previous?.privacyReleaseValidation.sourceBuildFingerprint !== privacyFingerprint;
    const rebuild = !old || old.inputHash !== inputHash || refresh || privacyChanged;
    const reason = !old
      ? "bootstrap"
      : refresh
        ? "security-refresh"
        : rebuild
          ? "inputs-changed"
          : "unchanged";
    // These proposed timestamps become authoritative only when promotion
    // advances release-manifest:main. Failed releases therefore remain due,
    // and cached source rebuilds cannot postpone an uncached security refresh.
    buildMetadata.images[target.app] = rebuild
      ? {
          inputHash,
          sourceRevision: revision,
          builtAt: now,
          coldRefreshedAt: refresh ? now : old.coldRefreshedAt,
        }
      : old;
    return {
      ...target,
      rebuild,
      refresh,
      reason,
      digest: rebuild ? "" : previous.images[target.app].split("@")[1],
      ...(bundleDigests[target.app] ? { bundleDigest: bundleDigests[target.app] } : {}),
    };
  });
  return {
    version: 1,
    release: releaseId,
    sourceRevision: revision,
    privacyFingerprint,
    images,
    buildMetadata,
  };
}

/** A failed registry request is not an absent release. Bootstrap only for the
 * registry's explicit missing-manifest response, never authentication/network errors. */
export function loadPreviousRelease(
  image,
  docker = (args) => spawnSync("docker", args, { encoding: "utf8" }),
) {
  const run = (args) => {
    const result = docker(args);
    if (result.status !== 0)
      throw new Error(
        `docker ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`,
      );
    return result.stdout.trim();
  };
  const pulled = docker(["pull", image]);
  if (pulled.status !== 0) {
    if (/manifest unknown|MANIFEST_UNKNOWN/.test(pulled.stderr ?? "")) return null;
    throw new Error(
      `Cannot read previous release: ${pulled.stderr || pulled.error?.message || pulled.status}`,
    );
  }
  // Use the locally pulled image ID, so a mutable remote tag cannot race cp.
  const digestMatches = [
    ...`${pulled.stdout}\n${pulled.stderr}`.matchAll(/^Digest: (sha256:[a-f0-9]{64})\r?$/gm),
  ];
  if (digestMatches.length !== 1) throw new Error("Missing or ambiguous baseline OCI digest");
  const repository = image.slice(0, image.lastIndexOf(":"));
  const id = run([
    "image",
    "inspect",
    `${repository}@${digestMatches[0][1]}`,
    "--format",
    "{{.Id}}",
  ]);
  if (!digestPattern.test(id)) throw new Error("Invalid baseline image ID");
  const container = run(["create", id, "true"]);
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid baseline container ID");
  const temp = mkdtempSync(join(tmpdir(), "openmapx-release-baseline-"));
  try {
    const path = join(temp, "release-manifest.json");
    run(["cp", `${container}:/release-manifest.json`, path]);
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    docker(["rm", "-f", container]);
    rmSync(temp, { recursive: true, force: true });
  }
}

// Failed-job retries reuse successful build-plan artifacts, but produce a new immutable release ID.
export function sameProducerPlan(planned, current) {
  if (planned === current) return true;
  if (typeof planned !== "string" || typeof current !== "string") return false;
  const a = /^([a-f0-9]{40}-[1-9][0-9]*)-([1-9][0-9]*)$/.exec(planned);
  const b = /^([a-f0-9]{40}-[1-9][0-9]*)-([1-9][0-9]*)$/.exec(current);
  return Boolean(a && b && a[1] === b[1] && BigInt(a[2]) <= BigInt(b[2]));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument, planPath] = process.argv.slice(2);
  if (command === "plan") {
    const root = process.cwd();
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (revision !== process.env.RELEASE_SHA)
      throw new Error("Release checkout does not match the gated revision");
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"]);
    const imagePrefix = process.env.IMAGE_PREFIX;
    if (!imagePrefix || !/^[-a-z0-9./:]+$/.test(imagePrefix))
      throw new Error("Invalid image prefix");
    if (!process.env.RELEASE_ID) throw new Error("Missing run-qualified release ID");
    const previous = loadPreviousRelease(`${imagePrefix}/release-manifest:main`);
    // The plan job installs the workspace, so the root `yaml` dependency resolves.
    const { parseAllDocuments } = await import("yaml");
    const lockfileDocuments = parseAllDocuments(readFileSync(join(root, LOCKFILE), "utf8"));
    if (lockfileDocuments.some((document) => document.errors.length > 0))
      throw new Error("Lockfile could not be parsed");
    // Bundled images are fingerprinted by their bundles, built here exactly as
    // the image's bundle stage builds them.
    const { RUNTIME_BUNDLES, buildRuntimeBundle } = await import("./build-runtime-bundles.mjs");
    const bundleDigests = {};
    for (const image of Object.keys(RUNTIME_BUNDLES)) {
      bundleDigests[image] = (await buildRuntimeBundle(root, image)).digest;
    }
    const plan = createReleasePlan({
      revision,
      releaseId: process.env.RELEASE_ID,
      tree: trackedTree(root),
      readDockerfile: (path) => readFileSync(join(root, path), "utf8"),
      privacyFingerprint: await computePrivacySourceFingerprint(root),
      previous,
      force: process.env.FORCE_REBUILD === "true",
      imagePrefix,
      lockfile: { documents: lockfileDocuments.map((document) => document.toJS()) },
      onLockfileFallback: (app, error) =>
        console.warn(`${app}: whole lockfile counted (${error.message})`),
      bundleDigests,
      readFile: (path) => readFileSync(join(root, path), "utf8"),
    });
    mkdirSync(argument, { recursive: true });
    writeFileSync(join(argument, "release-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    const summary = plan.images
      .map((image) => `${image.app}: ${image.rebuild ? "build" : "reuse"} (${image.reason})`)
      .join("\n");
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Image build selection\n\n\`\`\`\n${summary}\n\`\`\`\n`,
      );
  } else if (command === "select") {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const selected = plan.images?.find((image) => image.app === argument);
    if (
      plan.version !== 1 ||
      plan.sourceRevision !== process.env.RELEASE_SHA ||
      !sameProducerPlan(plan.release, process.env.RELEASE_ID) ||
      !targets.some((target) => target.app === argument) ||
      !selected ||
      typeof selected.rebuild !== "boolean" ||
      typeof selected.refresh !== "boolean" ||
      (!selected.rebuild && !digestPattern.test(selected.digest)) ||
      (selected.bundleDigest !== undefined && !hashPattern.test(selected.bundleDigest))
    )
      throw new Error("Invalid image selection plan");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `rebuild=${selected.rebuild}\nrefresh=${selected.refresh}\ndigest=${selected.rebuild ? "" : selected.digest}\nbundle_digest=${selected.bundleDigest ?? ""}\n`,
    );
    console.log(`${argument}: ${selected.rebuild ? "build" : "reuse"} (${selected.reason})`);
  } else if (command === "changed") {
    const base = argument;
    const head = planPath;
    if (!shaPattern.test(base ?? "") || !shaPattern.test(head ?? ""))
      throw new Error("Changed-image selection requires exact base and head revisions");
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GitHub output path");
    const root = process.cwd();
    const changedPaths = execFileSync(
      "git",
      // Renames must retain the removed input as well as the destination.
      ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`, "--"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
    const apps = selectChangedTargets({
      changedPaths,
      readDockerfile: (path) => readFileSync(join(root, path), "utf8"),
      tree: trackedTree(root),
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\n`);
    console.log(apps.length > 0 ? apps.join("\n") : "No Docker targets changed");
  } else {
    throw new Error(
      "Usage: docker-release-plan.mjs plan <output-directory> | select <app> <plan-path> | changed <base-sha> <head-sha>",
    );
  }
}
