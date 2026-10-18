// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: manual Actions IO, outside cached tasks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  assert,
  packageNames,
  repository,
  validateContext,
  validateNativePlan,
  versionPattern,
  workflow,
} from "./package-release-plan.mjs";

const registry = "https://registry.npmjs.org";
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const canonicalHash = (receipt) => hash(JSON.stringify(receipt));
const json = (file, limit = 128 * 1024) => {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.size <= limit, "Expected bounded regular JSON file");
    // Read one byte beyond the bound to detect growth without an unbounded
    // readFile allocation. All checks and reads refer to the opened inode.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    assert(length <= limit, "Expected bounded regular JSON file");
    assert(
      length === stat.size && fstatSync(fd).size === stat.size,
      "JSON file changed during bounded read",
    );
    return JSON.parse(bytes.toString("utf8", 0, length));
  } finally {
    closeSync(fd);
  }
};
function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    // Arguments and subprocess environment can contain credentials in other
    // contexts; callers need a bounded diagnostic, never an environment dump.
    const code =
      executable === "npm"
        ? /npm error code ([A-Z0-9_]+)/.exec(String(error.stderr ?? ""))?.[1]
        : null;
    const detail =
      executable === "npm"
        ? (code ?? "see npm command status")
        : String(error.stderr ?? error.message).slice(0, 4000);
    throw new Error(`${executable} failed (status ${error.status ?? "unknown"}): ${detail}`);
  }
}
function safePath(directory, path) {
  assert(
    typeof path === "string" && /^(?:packages|consumer)\/[a-z0-9.-]+\.tgz$/.test(path),
    "Unsafe candidate path",
  );
  const full = resolve(directory, path);
  assert(
    realpathSync(dirname(full)) === join(realpathSync(directory), path.split("/")[0]) &&
      lstatSync(dirname(full)).isDirectory() &&
      !lstatSync(dirname(full)).isSymbolicLink(),
    "Unsafe candidate directory path",
  );
  assert(
    lstatSync(full).isFile() &&
      !lstatSync(full).isSymbolicLink() &&
      lstatSync(full).size <= 32 * 1024 * 1024,
    "Candidate must be a bounded regular file",
  );
  return full;
}
function inventory(directory) {
  assert(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    "Unsafe artifact directory",
  );
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Symlink in artifact");
    if (entry.isDirectory()) {
      assert(["packages", "consumer"].includes(entry.name), "Extra artifact directory");
      for (const file of readdirSync(join(directory, entry.name), { withFileTypes: true })) {
        assert(file.isFile() && !file.isSymbolicLink(), "Nonregular artifact entry");
        files.push(`${entry.name}/${file.name}`);
      }
    } else {
      assert(entry.isFile(), "Nonregular artifact entry");
      files.push(entry.name);
    }
  }
  return files.sort();
}
function tarManifest(file, run = command) {
  const members = run("tar", ["-tzf", file]).split("\n").filter(Boolean);
  assert(
    members.length > 0 && members.length <= 3000 && new Set(members).size === members.length,
    "Empty/duplicate/excess tar entries",
  );
  assert(
    members.every((path) => {
      if (!path.startsWith("package/")) return false;
      const segments = path.split("/");
      segments.shift();
      if (segments.at(-1) === "") segments.pop();
      return segments.every(
        (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9_.@+-]+$/.test(segment),
      );
    }),
    "Unsafe tar member path",
  );
  assert(
    run("tar", ["-tvzf", file])
      .split("\n")
      .filter(Boolean)
      .every((line) => /^[-d]/.test(line)),
    "Symlink/hardlink/special tar entries rejected",
  );
  assert(
    members.filter((p) => p === "package/package.json").length === 1,
    "Missing/duplicate packed manifest",
  );
  const raw = run("tar", ["-xOf", file, "package/package.json"]);
  assert(raw.length <= 128 * 1024, "Oversized packed manifest");
  return JSON.parse(raw);
}
function metadata(manifest, item) {
  assert(
    manifest.name === item.name && manifest.version === item.version && manifest.private !== true,
    "Packed manifest identity mismatch",
  );
  assert(
    manifest.repository?.type === "git" &&
      manifest.repository.url === `git+https://github.com/${repository}.git` &&
      manifest.repository.directory === item.directory &&
      manifest.homepage === `https://github.com/${repository}`,
    "Packed provenance repository/directory/homepage metadata mismatch",
  );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
    for (const [name, range] of Object.entries(manifest[field] ?? {}))
      assert(
        !name.startsWith("@openmapx/") && !String(range).startsWith("workspace:"),
        "Unsupported packed runtime dependency topology",
      );
}
export function writePackageCandidate({ directory, batch, items, tools, run = command }) {
  validateContext(batch.context);
  assert(
    items.length === 2 &&
      new Set(items.map((p) => p.name)).size === 2 &&
      new Set(items.map((p) => p.path)).size === 2,
    "Duplicate/missing candidate entries",
  );
  const recorded = items.map((item) => {
    const expected = batch.consumers.find((p) => p.name === item.name);
    assert(
      expected && expected.version === item.version && expected.directory === item.directory,
      "Candidate outside qualified set",
    );
    assert(
      item.selected === batch.selected.some((p) => p.name === item.name),
      "Selected/consumer-only companion mismatch",
    );
    const path = safePath(directory, item.path);
    metadata(tarManifest(path, run), item);
    const bytes = readFileSync(path);
    return {
      name: item.name,
      directory: item.directory,
      version: item.version,
      path: item.path,
      selected: item.selected,
      sha512: hash(bytes, "sha512"),
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
    };
  });
  const nativePlan = json(join(directory, "publish-plan.json"));
  validateNativePlan(nativePlan, batch.consumers, batch.selected, true);
  for (const entry of nativePlan.plan.flat()) {
    const item = recorded.find((p) => p.name === entry.name);
    assert(
      item?.path === entry.tarball.path &&
        entry.tarball.integrity ===
          `sha256-${hash(readFileSync(safePath(directory, item.path)), "sha256", "base64")}`,
      "Native pack plan path/hash mismatch",
    );
  }
  const payload = {
    schemaVersion: 1,
    batch,
    tools,
    qualification: "strict-ts-and-cli-consumer",
    nativePlanSha256: hash(readFileSync(join(directory, "publish-plan.json"))),
    items: recorded,
  };
  const receipt = { ...payload, hash: canonicalHash(payload) };
  writeFileSync(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  readPackageCandidate({ directory, expectedHash: receipt.hash, context: batch.context, run });
  return receipt;
}
export function readPackageCandidate({ directory, expectedHash, context, run = command }) {
  validateContext(context);
  const receipt = json(join(directory, "receipt.json"));
  const { hash: recordedHash, ...payload } = receipt;
  assert(
    recordedHash === expectedHash &&
      canonicalHash(payload) === expectedHash &&
      /^[a-f0-9]{64}$/.test(expectedHash),
    "Candidate receipt hash mismatch",
  );
  assert(
    receipt.schemaVersion === 1 &&
      receipt.qualification === "strict-ts-and-cli-consumer" &&
      receipt.tools.changesets === "3.0.3" &&
      receipt.batch.toolVersion === "3.0.3",
    "Unsupported candidate/tool identity",
  );
  assert(
    JSON.stringify(receipt.batch.context) === JSON.stringify(context),
    "Candidate source/workflow/run/attempt mismatch",
  );
  assert(
    receipt.items.length === 2 &&
      new Set(receipt.items.map((p) => p.name)).size === 2 &&
      new Set(receipt.items.map((p) => p.path)).size === 2,
    "Duplicate candidate entries",
  );
  assert(
    JSON.stringify(inventory(directory)) ===
      JSON.stringify(
        ["receipt.json", "publish-plan.json", ...receipt.items.map((p) => p.path)].sort(),
      ),
    "Extra/missing artifact entries",
  );
  assert(
    hash(readFileSync(join(directory, "publish-plan.json"))) === receipt.nativePlanSha256,
    "Native plan hash mismatch",
  );
  const plan = json(join(directory, "publish-plan.json"));
  validateNativePlan(plan, receipt.batch.consumers, receipt.batch.selected, true);
  const all = receipt.items.map((item) => {
    assert(
      packageNames.includes(item.name) &&
        versionPattern.test(item.version) &&
        item.selected ===
          receipt.batch.selected.some((p) => p.name === item.name && p.version === item.version),
      "Candidate selected/companion mismatch",
    );
    const path = safePath(directory, item.path);
    const bytes = readFileSync(path);
    assert(
      item.sha512 === hash(bytes, "sha512") &&
        item.integrity === `sha512-${hash(bytes, "sha512", "base64")}`,
      "Candidate tarball hash mutation",
    );
    metadata(tarManifest(path, run), item);
    for (const entry of plan.plan.flat().filter((p) => p.name === item.name))
      assert(
        entry.tarball.path === item.path &&
          entry.tarball.integrity === `sha256-${hash(bytes, "sha256", "base64")}`,
        "Native tarball hash/path mismatch",
      );
    return { ...item, path };
  });
  return {
    batch: receipt.batch,
    hash: recordedHash,
    packages: all.filter((p) => p.selected),
    all,
    receipt,
  };
}

/** Input comes exclusively from npm's cryptographically verified audit bundles. */
export function verifyPackageProvenance(statement, item, batch) {
  const definition = statement?.predicate?.buildDefinition;
  const expected = {
    repository: `https://github.com/${repository}`,
    path: workflow,
    ref: "refs/heads/main",
  };
  assert(
    statement?._type === "https://in-toto.io/Statement/v1" &&
      statement.predicateType === "https://slsa.dev/provenance/v1",
    "Missing supported provenance statement",
  );
  const purl = `pkg:npm/${item.name.replaceAll("@", "%40")}@${item.version}`;
  assert(
    statement.subject?.length === 1 &&
      statement.subject[0].name === purl &&
      statement.subject[0].digest?.sha512 === item.sha512,
    "Provenance subject/digest mismatch",
  );
  assert(
    definition?.buildType ===
      "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" &&
      Object.entries(expected).every(
        ([key, value]) => definition.externalParameters?.workflow?.[key] === value,
      ),
    "Provenance repository/workflow/ref mismatch",
  );
  assert(
    definition.internalParameters?.github?.event_name === "workflow_dispatch" &&
      definition.resolvedDependencies?.length === 1 &&
      definition.resolvedDependencies[0].uri ===
        `git+https://github.com/${repository}@refs/heads/main` &&
      definition.resolvedDependencies[0].digest?.gitCommit === batch.context.sha,
    "Provenance source mismatch",
  );
  assert(
    statement.predicate.runDetails?.builder?.id ===
      "https://github.com/actions/runner/github-hosted",
    "Provenance builder mismatch",
  );
  // A retry may verify a prior publishing run, but its source and workflow must
  // remain identical; do not claim the retry created the earlier attestation.
  assert(
    new RegExp(
      `^https://github\\.com/${repository}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$`,
    ).test(statement.predicate.runDetails?.metadata?.invocationId),
    "Provenance invocation mismatch",
  );
}

export function createPackageReleasePorts(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const candidateDirectory = () => {
    const directory = options.directory ?? process.env.PACKAGE_ARTIFACT_DIRECTORY;
    assert(
      typeof directory === "string" && directory.length > 0,
      "Candidate operations require an explicit artifact directory",
    );
    return directory;
  };
  const run = options.run ?? command;
  const fetch = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? setTimeout;
  const api = (path, method = "GET", body) =>
    JSON.parse(
      run("gh", ["api", path, "--method", method, ...(body ? ["--input", "-"] : [])], {
        cwd,
        ...(body ? { input: JSON.stringify(body), stdio: ["pipe", "pipe", "pipe"] } : {}),
      }),
    );
  const readRun = async (id) => {
    assert(Number.isSafeInteger(id) && id > 0, "Invalid CI run ID");
    const latest = api(`repos/${repository}/actions/runs/${id}`);
    assert(
      Number.isSafeInteger(latest.run_attempt) && latest.run_attempt > 0,
      "Invalid CI run attempt",
    );
    const attempt = api(`repos/${repository}/actions/runs/${id}/attempts/${latest.run_attempt}`);
    assert(
      attempt.id === latest.id && attempt.run_attempt === latest.run_attempt,
      "CI run attempt identity mismatch",
    );
    return attempt;
  };
  const ghPr = (number) => {
    assert(Number.isSafeInteger(number) && number > 0, "Invalid version PR number");
    return api(`repos/${repository}/pulls/${number}`);
  };
  const git = (...args) => run("git", args, { cwd });
  async function registryRead(
    url,
    { optional = false, bytes = false, limit = 16 * 1024 * 1024 } = {},
  ) {
    const target = new URL(url);
    assert(
      target.origin === registry && !target.username && !target.password,
      "Untrusted registry URL",
    );
    const response = await fetch(target.href, {
      headers: { accept: bytes ? "application/octet-stream" : "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (optional && response.status === 404) return null;
    assert(response.ok, `Public npm registry GET failed (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert(size <= limit, "Oversized npm registry response");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    return bytes ? body : JSON.parse(body.toString("utf8"));
  }
  async function registryVersion(item) {
    assert(
      packageNames.includes(item.name) && versionPattern.test(item.version),
      "Invalid registry package/version",
    );
    const result = await registryRead(`${registry}/${encodeURIComponent(item.name)}`, {
      optional: true,
    });
    assert(
      result !== null,
      `${item.name}: bootstrap needed; whole package is absent. First publication requires separate authorization and npm configuration.`,
    );
    assert(
      result.name === item.name &&
        result.versions &&
        typeof result.versions === "object" &&
        !Array.isArray(result.versions),
      "Malformed npm registry metadata",
    );
    const version = result.versions[item.version];
    if (version === undefined) return null;
    assert(
      version.name === item.name &&
        version.version === item.version &&
        typeof version.dist?.integrity === "string" &&
        typeof version.dist?.tarball === "string",
      "Malformed exact npm version metadata",
    );
    return version;
  }
  function npmSpace(callback) {
    const temp = mkdtempSync(join(tmpdir(), "openmapx-npm-verify-"));
    writeFileSync(
      join(temp, "package.json"),
      JSON.stringify({ name: "openmapx-verify-published-package", private: true }),
    );
    for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(temp, file), "");
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(npm_config_|node_auth_token$|npm_token$)/i.test(key)) delete env[key];
    Object.assign(env, {
      npm_config_userconfig: join(temp, "user.npmrc"),
      npm_config_globalconfig: join(temp, "global.npmrc"),
      npm_config_cache: join(temp, "cache"),
      npm_config_update_notifier: "false",
      npm_config_registry: registry,
    });
    return Promise.resolve()
      .then(() => callback(temp, env))
      .finally(() => rmSync(temp, { recursive: true, force: true }));
  }
  const ports = {
    async inspectSource(input) {
      validateContext(input.context);
      assert(
        git("rev-parse", "HEAD") === input.context.sha,
        "Checkout differs from dispatch source",
      );
      const {
        snapshot,
        publicPackages,
        contributionCheck,
        git: trustedGit,
      } = await import("./check-release-information.mjs");
      const { canonicalPackageVersion, validateVersionBaseline, pendingVersionNotes } =
        await import("./canonical-package-version.mjs");
      const state = snapshot(cwd, input.context.sha);
      validateVersionBaseline(state);
      const allowlist = publicPackages(state);
      const packages = allowlist.map((p) => ({
        ...p,
        ...state.json(`${p.directory}/package.json`),
        directory: p.directory,
      }));
      const pending = pendingVersionNotes(state);
      let ci = null;
      let pr = null;
      let canonical = null;
      if (input.operation === "publish") {
        ci = await readRun(input.sourceRunId);
        pr = ghPr(input.versionPr);
        assert(
          pr.merged === true &&
            /^[a-f0-9]{40}$/.test(pr.merge_commit_sha) &&
            /^[a-f0-9]{40}$/.test(pr.head?.sha),
          "Invalid/unmerged version PR",
        );
        git("fetch", "--no-tags", "origin", pr.merge_commit_sha, pr.head.sha);
        const parents = git("rev-list", "--parents", "-n", "1", pr.merge_commit_sha).split(" ");
        assert(parents.length === 2, "Version PR must use the repository's squash-merge policy");
        const parent = parents[1];
        const before = snapshot(cwd, parent);
        const after = snapshot(cwd, pr.merge_commit_sha);
        const originalBase = git("merge-base", parent, pr.head.sha);
        for (const [base, head] of [
          [before, after],
          [snapshot(cwd, originalBase), snapshot(cwd, pr.head.sha)],
        ]) {
          assert(
            base
              .read("scripts/public-packages.json")
              .equals(state.read("scripts/public-packages.json")) &&
              head
                .read("scripts/public-packages.json")
                .equals(state.read("scripts/public-packages.json")),
            "Changed qualified public allowlist since version PR",
          );
          const changed = trustedGit(
            cwd,
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            base.ref,
            head.ref,
          )
            .toString()
            .split("\0")
            .filter(Boolean);
          canonicalPackageVersion({
            cwd,
            before: base,
            after: head,
            changed,
            packages: publicPackages(base),
            git: trustedGit,
            validatePending() {
              const notes = pendingVersionNotes(base);
              assert(notes.length > 0, "Version PR had no pending qualified Changesets");
              const check = contributionCheck({
                before: base,
                after: base,
                changed: notes,
                body: pr.body ?? "",
              });
              assert(!check.errors.length, check.errors.join("\n"));
            },
          });
        }
        const mergeBase = git("merge-base", pr.merge_commit_sha, input.context.sha);
        canonical = {
          valid: true,
          reachable: mergeBase === pr.merge_commit_sha,
          mergeSha: pr.merge_commit_sha,
          headSha: pr.head.sha,
          packages: allowlist
            .filter(
              (p) =>
                before.json(`${p.directory}/package.json`).version !==
                after.json(`${p.directory}/package.json`).version,
            )
            .map((p) => ({
              name: p.name,
              version: after.json(`${p.directory}/package.json`).version,
            })),
        };
      }
      const toolVersion = createRequire(import.meta.url)("@changesets/cli/package.json").version;
      assert(toolVersion === "3.0.3", "Experimental native plan requires Changesets 3.0.3");
      // Fail source authority before the registry-facing native command or packing.
      const { planPackageRelease } = await import("./package-release-plan.mjs");
      const validatedBatch = planPackageRelease({
        ...input,
        packages,
        pending,
        ci,
        pr,
        canonical,
        toolVersion,
        nativePlan: { version: 1, plan: [] },
      });
      if (input.operation === "publish")
        for (const item of validatedBatch.selected) await registryVersion(item);
      const temp = mkdtempSync(join(tmpdir(), "openmapx-native-plan-"));
      try {
        const file = join(temp, "plan.json");
        const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
        run(process.execPath, [cli, "publish-plan", "--output", file], { cwd });
        return {
          ...input,
          packages,
          pending,
          ci,
          pr,
          canonical,
          toolVersion,
          nativePlan: json(file),
        };
      } finally {
        rmSync(temp, { force: true, recursive: true });
      }
    },
    async qualify(batch, nativePlan) {
      const directory = candidateDirectory();
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code === "EEXIST")
          throw new Error("Candidate directory already exists; use a fresh fixed-run directory");
        throw error;
      }
      const temp = mkdtempSync(join(tmpdir(), "openmapx-package-plan-"));
      try {
        const planPath = join(temp, "publish-plan.json");
        writeFileSync(planPath, JSON.stringify(nativePlan));
        const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
        run(
          process.execPath,
          [cli, "pack", "--from-publish-plan", planPath, "--out-dir", directory],
          { cwd, timeout: 300000 },
        );
        const packed = json(join(directory, "publish-plan.json"));
        validateNativePlan(packed, batch.consumers, batch.selected, true);
        const items = [];
        for (const item of batch.consumers) {
          const selected = batch.selected.some((p) => p.name === item.name);
          const entry = packed.plan.flat().find((p) => p.name === item.name);
          let path = entry?.tarball.path;
          if (!entry) {
            // Native publish-plan omits versions already in npm. Pack those
            // explicitly for consumer coverage and retry byte verification only.
            const folder = selected ? "packages" : "consumer";
            mkdirSync(join(directory, folder), { recursive: true });
            path = `${folder}/${item.name.slice(1).replace("/", "-")}-${item.version}.tgz`;
            run("pnpm", ["--filter", item.name, "pack", "--out", join(directory, path)], {
              cwd,
              timeout: 300000,
            });
          }
          items.push({ ...item, path, selected });
        }
        const hashes = items.map((item) =>
          hash(readFileSync(safePath(directory, item.path)), "sha512"),
        );
        const paths = batch.consumers.map((p) =>
          join(directory, items.find((item) => item.name === p.name).path),
        );
        const contracts = paths[batch.consumers.findIndex((p) => p.name === packageNames[0])];
        const extensionCli = paths[batch.consumers.findIndex((p) => p.name === packageNames[1])];
        run(
          process.execPath,
          [
            join(cwd, "scripts/check-packed-packages.mjs"),
            "--contracts",
            contracts,
            "--cli",
            extensionCli,
          ],
          { cwd, timeout: 300000 },
        );
        assert(
          items.every(
            (item, i) => hashes[i] === hash(readFileSync(safePath(directory, item.path)), "sha512"),
          ),
          "Consumer qualification mutated candidate bytes",
        );
        const tools = {
          changesets: batch.toolVersion,
          node: process.version,
          npm: run("npm", ["--version"], { cwd }),
          pnpm: run("pnpm", ["--version"], { cwd }),
        };
        const receipt = writePackageCandidate({ directory, batch, items, tools, run });
        return readPackageCandidate({
          directory,
          expectedHash: receipt.hash,
          context: batch.context,
          run,
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    async readCandidate(request) {
      return readPackageCandidate({
        directory: candidateDirectory(),
        expectedHash: request.candidateHash,
        context: request.context,
        run,
      });
    },
    async validateArtifact(candidate, request) {
      const directory = candidateDirectory();
      const artifact = api(`repos/${repository}/actions/artifacts/${request.artifactId}`);
      assert(
        artifact.id === request.artifactId &&
          artifact.expired === false &&
          artifact.name ===
            `package-candidate-${request.context.runId}-${request.context.attempt}` &&
          artifact.workflow_run?.id === request.context.runId &&
          artifact.workflow_run?.head_sha === request.context.sha,
        "Wrong source/run/attempt artifact identity",
      );
      const fresh = readPackageCandidate({
        directory,
        expectedHash: request.candidateHash,
        context: request.context,
        run,
      });
      assert(
        fresh.hash === candidate.hash && git("rev-parse", "HEAD") === request.context.sha,
        "Post-approval artifact/source mismatch",
      );
      const ci = await readRun(candidate.batch.sourceCI?.runId);
      assert(
        ci.run_attempt === candidate.batch.sourceCI.attempt &&
          ci.status === "completed" &&
          ci.conclusion === "success" &&
          ci.path === ".github/workflows/ci.yml" &&
          ci.head_sha === request.context.sha &&
          ci.head_branch === "main" &&
          ["push", "schedule"].includes(ci.event) &&
          ci.repository?.full_name === repository &&
          ci.head_repository?.full_name === repository,
        "Post-approval CI identity changed",
      );
      const pr = ghPr(candidate.batch.versionPr?.number);
      assert(
        pr.merged === true &&
          pr.merge_commit_sha === candidate.batch.versionPr.mergeSha &&
          pr.head?.sha === candidate.batch.versionPr.headSha &&
          pr.base?.ref === "main" &&
          pr.base.repo?.full_name === repository &&
          pr.head.repo?.full_name === repository,
        "Post-approval version PR identity changed",
      );
      assert(
        git("merge-base", pr.merge_commit_sha, request.context.sha) === pr.merge_commit_sha,
        "Version PR not reachable from dispatch source",
      );
    },
    async assertNpm() {
      assert(
        !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN,
        "Stored npm token fallback is forbidden",
      );
      const version = run("npm", ["--version"], { cwd });
      const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
      assert(
        parts && (parts[0] > 11 || (parts[0] === 11 && parts[1] >= 19)),
        "npm >=11.19.0 required (Trusted Publishing >=11.5.1 plus verified attestation-bundle audit output); use pinned Node, no global upgrade",
      );
    },
    registryVersion,
    async verifyPublished(item, metadata, batch) {
      assert(
        metadata.dist.integrity === item.integrity,
        "Existing npm version has conflicting integrity",
      );
      const bytes = await registryRead(metadata.dist.tarball, {
        bytes: true,
        limit: 32 * 1024 * 1024,
      });
      assert(hash(bytes, "sha512") === item.sha512, "Existing npm version has conflicting bytes");
      assert(metadata.dist.attestations?.url, "Missing public npm provenance");
      await npmSpace(async (temp, env) => {
        run(
          "npm",
          [
            "install",
            `${item.name}@${item.version}`,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--registry",
            registry,
          ],
          { cwd: temp, env, timeout: 180000 },
        );
        const lock = json(join(temp, "package-lock.json"), 4 * 1024 * 1024);
        assert(
          lock.packages?.[`node_modules/${item.name}`]?.integrity === item.integrity,
          "Registry install differs from candidate",
        );
        const audit = JSON.parse(
          run(
            "npm",
            ["audit", "signatures", "--json", "--include-attestations", "--registry", registry],
            { cwd: temp, env, timeout: 180000 },
          ),
        );
        assert(
          Array.isArray(audit.invalid) &&
            audit.invalid.length === 0 &&
            Array.isArray(audit.missing) &&
            audit.missing.length === 0,
          "Cryptographic npm signature/provenance audit failed",
        );
        const verified = audit.verified?.find(
          (p) =>
            p.name === item.name && p.version === item.version && p.registry === `${registry}/`,
        );
        const bundles = verified?.attestationBundles?.filter(
          (p) => p.predicateType === "https://slsa.dev/provenance/v1",
        );
        assert(bundles?.length === 1, "No uniquely verified public provenance bundle");
        const envelope = bundles[0].bundle?.dsseEnvelope;
        assert(
          envelope?.payloadType === "application/vnd.in-toto+json" &&
            typeof envelope.payload === "string" &&
            envelope.payload.length <= 128 * 1024,
          "Malformed verified provenance bundle",
        );
        verifyPackageProvenance(
          JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
          item,
          batch,
        );
      });
    },
    async publishTarball(item) {
      return npmSpace(async (temp, env) => {
        assert(
          hash(readFileSync(item.path), "sha512") === item.sha512,
          "Candidate changed before npm publication",
        );
        run(
          "npm",
          [
            "publish",
            item.path,
            "--ignore-scripts",
            "--access",
            "public",
            "--tag",
            "latest",
            "--provenance",
            "--registry",
            registry,
          ],
          { cwd: temp, env, timeout: 180000 },
        );
      });
    },
    async readTag(item) {
      const tag = `${item.name}@${item.version}`;
      const refs = api(`repos/${repository}/git/matching-refs/tags/${encodeURIComponent(tag)}`);
      assert(Array.isArray(refs), "Malformed package tag response");
      const ref = refs.find((r) => r.ref === `refs/tags/${tag}`);
      if (!ref) return null;
      let object = ref.object;
      for (let i = 0; object?.type === "tag" && i < 3; i++) {
        assert(/^[a-f0-9]{40}$/.test(object.sha), "Invalid tag object");
        object = api(`repos/${repository}/git/tags/${object.sha}`).object;
      }
      assert(
        object?.type === "commit" && /^[a-f0-9]{40}$/.test(object.sha),
        "Invalid package tag target",
      );
      return object.sha;
    },
    async createTag(item, source) {
      const current = await ports.readTag(item);
      assert(current === null || current === source, "Conflicting existing package tag");
      if (current === source) return;
      try {
        api(`repos/${repository}/git/refs`, "POST", {
          ref: `refs/tags/${item.name}@${item.version}`,
          sha: source,
        });
      } catch (error) {
        throw new Error(
          `Package verified in npm but tag creation failed. Maintainer: create only ${item.name}@${item.version} at ${source}, or retry with workflow authority; do not retag main or use a stored PAT. ${error.message}`,
        );
      }
      assert(
        (await ports.readTag(item)) === source,
        "Created package tag did not resolve to bound source",
      );
    },
    wait,
  };
  return ports;
}
