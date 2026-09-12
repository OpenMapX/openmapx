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
  { app: "docs", context: "docs", dockerfile: "docs/Dockerfile" },
];
const shaPattern = /^[a-f0-9]{40}$/;
const releasePattern = /^[a-f0-9]{40}(?:-[1-9][0-9]*-[1-9][0-9]*)?$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxBuildAge = 7 * 24 * 60 * 60 * 1000;
const globalInputs = [
  ".github/workflows/docker.yml",
  ".github/workflows/ci.yml",
  "scripts/docker-release-plan.mjs",
];

/** Conservative coverage, not a second Docker parser. Unsupported constructs
 * expand to the whole context. Exclusions deliberately do not narrow coverage. */
export function dockerInputs(dockerfile, context) {
  const fallback = [context];
  if (/^\s*#\s*escape\s*=/im.test(dockerfile) || /\bONBUILD\b|<<|--mount=/i.test(dockerfile))
    return fallback;
  const lines = dockerfile
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");
  const inputs = [];
  for (const match of lines.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gim)) {
    let args = match[1].trim();
    let fromStage = false;
    while (args.startsWith("--")) {
      const flag = args.match(
        /^--(from|chown|chmod|exclude|link|parents|checksum|keep-git-dir|unpack)(?:=([^\s]+))?\s+/,
      );
      if (!flag) return fallback;
      if (flag[1] === "from") fromStage = true;
      args = args.slice(flag[0].length);
    }
    if (fromStage) continue;
    let paths;
    try {
      paths = args.startsWith("[") ? JSON.parse(args) : args.split(/\s+/);
    } catch {
      return fallback;
    }
    if (!Array.isArray(paths) || paths.length < 2 || paths.some((path) => typeof path !== "string"))
      return fallback;
    for (let source of paths.slice(0, -1)) {
      if (/[\s$'"\\]/.test(source) || source.includes("://") || source.split("/").includes(".."))
        return fallback;
      source = source.replace(/^\/+/, "");
      const wildcard = source.search(/[*?[]/);
      if (wildcard !== -1) {
        const prefix = source.slice(0, wildcard);
        source = prefix.endsWith("/") ? prefix.slice(0, -1) : posix.dirname(prefix);
      }
      inputs.push(posix.normalize(posix.join(context, source || ".")).replace(/\/$/, ""));
    }
  }
  return [...new Set(inputs)];
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

export function imageFingerprint({ target, tree, readDockerfile, privacyFingerprint }) {
  const dockerfile = readDockerfile(target.dockerfile);
  const inputs = [
    ...dockerInputs(dockerfile, target.context),
    target.dockerfile,
    posix.join(target.context, ".dockerignore"),
    `${target.dockerfile}.dockerignore`,
    ...globalInputs,
  ];
  const covered = (path) =>
    inputs.some((input) => input === "." || path === input || path.startsWith(`${input}/`));
  let entries = tree.filter((entry) => covered(entry.path));
  // A copied symlink may resolve to another tracked path. Include the whole tree
  // rather than guessing which side of a Docker COPY dereferences it.
  if (entries.some((entry) => entry.mode === "120000")) entries = tree;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["openmapx/docker-inputs/v1", target, "linux/amd64", dockerfile]));
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
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
    !releasePattern.test(previous.release ?? "") ||
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
    const inputHash = imageFingerprint({ target, tree, readDockerfile, privacyFingerprint });
    const old =
      previous?.buildMetadata?.version === 1
        ? previous.buildMetadata.images[target.app]
        : undefined;
    const refresh =
      force ||
      Boolean(
        old &&
          (currentTime - timestamp(old.builtAt) >= maxBuildAge ||
            timestamp(old.builtAt) > currentTime),
      );
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
    buildMetadata.images[target.app] = rebuild
      ? { inputHash, sourceRevision: revision, builtAt: now }
      : old;
    return {
      ...target,
      rebuild,
      refresh,
      reason,
      digest: rebuild ? "" : previous.images[target.app].split("@")[1],
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
  const id = run(["image", "inspect", image, "--format", "{{.Id}}"]);
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
    const previous = loadPreviousRelease(`${imagePrefix}/release-manifest:latest`);
    const plan = createReleasePlan({
      revision,
      releaseId: process.env.RELEASE_ID,
      tree: trackedTree(root),
      readDockerfile: (path) => readFileSync(join(root, path), "utf8"),
      privacyFingerprint: await computePrivacySourceFingerprint(root),
      previous,
      force: process.env.FORCE_REBUILD === "true",
      imagePrefix,
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
      plan.release !== process.env.RELEASE_ID ||
      !targets.some((target) => target.app === argument) ||
      !selected ||
      typeof selected.rebuild !== "boolean" ||
      typeof selected.refresh !== "boolean" ||
      (!selected.rebuild && !digestPattern.test(selected.digest))
    )
      throw new Error("Invalid image selection plan");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `rebuild=${selected.rebuild}\nrefresh=${selected.refresh}\ndigest=${selected.rebuild ? "" : selected.digest}\n`,
    );
    console.log(`${argument}: ${selected.rebuild ? "build" : "reuse"} (${selected.reason})`);
  } else {
    throw new Error(
      "Usage: docker-release-plan.mjs plan <output-directory> | select <app> <plan-path>",
    );
  }
}
