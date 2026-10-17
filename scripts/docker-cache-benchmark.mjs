// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Uncached Actions CLI; these inputs do not participate in Turbo tasks.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const policies = ["max", "min", "main-only"];
const phases = ["cold", "unchanged", "source"];
const buildkitImage =
  "moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
const frontend =
  "docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6";
const sbomGenerator =
  "docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9";
const changedSource = "apps/api/src/server.ts";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function prepare(output, policy, sample, phase) {
  if (!policies.includes(policy) || !phases.includes(phase) || !/^[12]$/.test(sample)) {
    throw new Error("Invalid benchmark policy, sample or phase");
  }
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(run ?? "") || !/^\d+$/.test(attempt ?? "")) {
    throw new Error("A GitHub run and attempt identity are required");
  }
  const root = realpathSync(git("rev-parse", "--show-toplevel"));
  // Resolve existing ancestors as well as lexical segments: /var aliases and
  // symlinked output parents must not put artifacts inside the build context.
  let ancestor = resolve(output);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const distance = relative(root, resolve(realpathSync(ancestor), ...missing));
  if (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance)) {
    throw new Error("Benchmark results must be outside the Docker context");
  }
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error("Benchmark input must be a clean checkout before each case");
  }
  if (phase === "source") {
    appendFileSync(changedSource, "\n// Docker cache benchmark: source-only change.\n");
    if (git("diff", "--name-only") !== changedSource) throw new Error("Unexpected input changes");
  }
  const scope = `ci-benchmark-api-${run}-${attempt}-${policy}-${sample}`;
  const input = {
    policy,
    sample,
    phase,
    scope,
    run,
    attempt,
    sourceRevision: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    diffSha256: hash(execFileSync("git", ["diff", "--binary"])),
    dockerfileSha256: hash(readFileSync("apps/api/Dockerfile")),
    lockfileSha256: hash(readFileSync("pnpm-lock.yaml")),
  };
  const directory = join(output, phase);
  mkdirSync(directory, { recursive: true });
  save(join(directory, "input.json"), input);
  const options = {
    scope,
    "buildkit-image": buildkitImage,
    "dockerfile-frontend": frontend,
    "sbom-generator": sbomGenerator,
    "cache-from":
      phase === "cold" || policy === "main-only" ? "" : `type=gha,version=2,scope=${scope}`,
    "cache-to": policy === "main-only" ? "" : `type=gha,version=2,mode=${policy},scope=${scope}`,
    "no-cache": String(phase === "cold"),
  };
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(options)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

export function parseProgress(raw) {
  const vertices = new Map();
  for (const line of raw.split("\n").filter((value) => value.trim())) {
    const message = JSON.parse(line);
    for (const event of message.vertexes ?? [message]) {
      // Console log payloads and transfer messages are not persisted in receipts.
      if (!event.name && !event.started && !event.completed && !event.cached) continue;
      const id = event.id ?? event.vertex ?? event.digest;
      if (!id) continue;
      const previous = vertices.get(id) ?? {};
      const next = { ...previous, ...event, id };
      if (
        previous.started &&
        event.started &&
        Date.parse(previous.started) < Date.parse(event.started)
      )
        next.started = previous.started;
      if (
        previous.completed &&
        event.completed &&
        Date.parse(previous.completed) > Date.parse(event.completed)
      )
        next.completed = previous.completed;
      vertices.set(id, next);
    }
  }
  if (!vertices.size) throw new Error("No BuildKit vertex timing evidence");
  const result = [...vertices.values()].map((vertex) => {
    const start = Date.parse(vertex.started);
    const end = Date.parse(vertex.completed);
    if (
      !vertex.name ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      vertex.error
    ) {
      throw new Error("Incomplete or failed BuildKit vertex timing evidence");
    }
    return {
      id: vertex.id,
      name: vertex.name,
      seconds: (end - start) / 1000,
      cached: Boolean(vertex.cached),
    };
  });
  return {
    exportSeconds: result
      .filter((vertex) => /exporting to GitHub Actions Cache/i.test(vertex.name))
      .reduce((sum, vertex) => sum + vertex.seconds, 0),
    vertices: result,
  };
}

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Docker evidence command failed: ${args.slice(0, 3).join(" ")} (${result.status})`,
    );
  return result;
}

export function collect(directory) {
  const actionSeconds = (Date.now() - readJson(join(directory, "start.json")).at) / 1000;
  const input = readJson(join(directory, "input.json"));
  const metadata = JSON.parse(process.env.BUILD_METADATA);
  const ref = metadata["buildx.build.ref"];
  if (typeof ref !== "string" || !/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(ref))
    throw new Error("Missing build record reference");
  const builder = process.env.BENCHMARK_BUILDER;
  if (builder !== ref.split("/")[0]) throw new Error("Build record belongs to another builder");
  const build = JSON.parse(
    docker(
      "buildx",
      "history",
      "inspect",
      "--builder",
      builder,
      "--format",
      "json",
      ref.split("/").at(-1),
    ).stdout,
  );
  if (build.Status !== "completed" || !Number.isFinite(build.Duration) || build.Duration < 0)
    throw new Error("Build did not complete with timing evidence");
  const logs = docker(
    "buildx",
    "history",
    "logs",
    "--builder",
    builder,
    "--progress",
    "rawjson",
    ref.split("/").at(-1),
  );
  const progress = parseProgress(logs.stdout + logs.stderr);
  if (
    input.policy !== "main-only" &&
    !progress.vertices.some((vertex) => /exporting to GitHub Actions Cache/i.test(vertex.name))
  ) {
    throw new Error("Expected cache export timing is missing");
  }
  const node = ref.split("/")[1];
  // buildx du formats Size for display. buildctl exposes the exact UsageInfo
  // byte counts from this owned docker-container builder instead.
  const records = JSON.parse(
    docker("exec", `buildx_buildkit_${node}`, "buildctl", "du", "--format", "{{json .}}").stdout,
  );
  const ids = new Set();
  const localCacheBytes = records.reduce((sum, record) => {
    if (!Number.isSafeInteger(record.size) || record.size < 0 || !record.id || ids.has(record.id))
      throw new Error("Unknown local cache byte format");
    ids.add(record.id);
    return sum + record.size;
  }, 0);
  save(join(directory, "result.json"), {
    ...input,
    actionSeconds,
    buildSeconds: build.Duration / 1e9,
    exportSeconds: progress.exportSeconds,
    localCacheBytes,
    cachedSteps: build.NumCachedSteps,
    totalSteps: build.NumTotalSteps,
    materials: build.Materials,
    attachments: build.Attachments,
    buildx: docker("buildx", "version").stdout.trim(),
    node: process.version,
    configuredBuildkitImage: buildkitImage,
    configuredFrontend: frontend,
    configuredSbomGenerator: sbomGenerator,
    runnerImage: process.env.ImageVersion ?? null,
    vertices: progress.vertices,
  });
}

function resultFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? resultFiles(join(directory, entry.name))
      : entry.name === "result.json"
        ? [join(directory, entry.name)]
        : [],
  );
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function report(directory, sampleCount) {
  if (process.env.MATRIX_RESULT !== "success" || !/^[12]$/.test(sampleCount))
    throw new Error("Benchmark matrix did not succeed");
  const samples = Number(sampleCount);
  const records = resultFiles(directory).map(readJson);
  const metrics = readJson(join(directory, "job-metrics.json"));
  const expected = policies.length * phases.length * samples;
  if (records.length !== expected) throw new Error("Missing or extra benchmark cases");
  const seen = new Set();
  const same = (key) => {
    if (
      records.some((record) => typeof record[key] !== "string" || !record[key]) ||
      new Set(records.map((record) => JSON.stringify(record[key]))).size !== 1
    )
      throw new Error(`Incomparable benchmark ${key}`);
  };
  for (const key of [
    "run",
    "attempt",
    "sourceRevision",
    "sourceTree",
    "lockfileSha256",
    "dockerfileSha256",
    "buildx",
    "node",
    "runnerImage",
    "configuredBuildkitImage",
    "configuredFrontend",
    "configuredSbomGenerator",
  ])
    same(key);
  if (
    records[0].sourceRevision !== metrics.source ||
    records[0].run !== String(metrics.run) ||
    records[0].attempt !== String(metrics.attempt)
  )
    throw new Error("Job metrics belong to another source or attempt");
  for (const record of records) {
    const key = `${record.policy}/${record.sample}/${record.phase}`;
    if (
      !policies.includes(record.policy) ||
      !phases.includes(record.phase) ||
      !/^[12]$/.test(record.sample) ||
      Number(record.sample) > samples ||
      seen.has(key)
    )
      throw new Error("Duplicate or invalid benchmark case");
    seen.add(key);
    if (
      !Array.isArray(record.materials) ||
      record.materials.length === 0 ||
      record.materials.some(
        (material) =>
          !material ||
          typeof material.URI !== "string" ||
          !material.URI.trim() ||
          !Array.isArray(material.Digests) ||
          material.Digests.length === 0 ||
          material.Digests.some((digest) => typeof digest !== "string" || !digest.trim()),
      )
    )
      throw new Error("Incomplete resolved materials evidence");
    for (const field of [
      "actionSeconds",
      "buildSeconds",
      "exportSeconds",
      "localCacheBytes",
      "cachedSteps",
      "totalSteps",
    ]) {
      if (!Number.isFinite(record[field]) || record[field] < 0)
        throw new Error(`Invalid ${field} evidence`);
    }
  }
  for (const field of [
    "sourceRevision",
    "sourceTree",
    "lockfileSha256",
    "dockerfileSha256",
    "diffSha256",
  ]) {
    const pattern =
      field === "sourceRevision" || field === "sourceTree" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (records.some((record) => !pattern.test(record[field])))
      throw new Error("Invalid source identity evidence");
  }
  const baseDiff = records.find((record) => record.phase === "cold").diffSha256;
  if (
    records.some((record) => record.phase === "unchanged" && record.diffSha256 !== baseDiff) ||
    records.some((record) => record.phase === "source" && record.diffSha256 === baseDiff)
  )
    throw new Error("Workload source change is missing or misplaced");
  for (const phase of phases) {
    const group = records.filter((record) => record.phase === phase);
    if (
      new Set(group.map((record) => record.diffSha256)).size !== 1 ||
      new Set(
        group.map((record) =>
          JSON.stringify(
            record.materials
              .map((material) => ({ URI: material.URI, Digests: [...material.Digests].sort() }))
              .sort((a, b) => a.URI.localeCompare(b.URI)),
          ),
        ),
      ).size !== 1
    )
      throw new Error("Source changes or resolved materials differ between cases");
  }
  const jobKeys = new Set();
  let summedWorkerSeconds = 0;
  for (const job of metrics.jobs) {
    const match = /^Benchmark (max|min|main-only) \/ sample ([12])$/.exec(job.name);
    if (
      !match ||
      Number(match[2]) > samples ||
      jobKeys.has(job.name) ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    )
      throw new Error("Missing or unsuccessful benchmark worker");
    const seconds = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid worker timestamps");
    summedWorkerSeconds += seconds;
    jobKeys.add(job.name);
  }
  if (jobKeys.size !== policies.length * samples) throw new Error("Incomplete worker metrics");
  // A rerun retains the run's original created_at; it is not an attempt enqueue time.
  const startDelay = (Date.parse(metrics.startedAt) - Date.parse(metrics.createdAt)) / 1000;
  if (!Number.isFinite(startDelay) || startDelay < 0)
    throw new Error("Invalid run queue timestamps");
  const queueSeconds = Number(metrics.attempt) === 1 ? startDelay : null;
  const comparison = {
    sourceRevision: metrics.source,
    run: metrics.run,
    attempt: metrics.attempt,
    queueSeconds,
    summedWorkerSeconds,
    repositoryCacheBytesObserved: metrics.repositoryCacheBytesObserved,
    policies: Object.fromEntries(
      policies.map((policy) => {
        const group = records.filter((record) => record.policy === policy);
        return [
          policy,
          {
            totalActionSeconds: group.reduce((sum, record) => sum + record.actionSeconds, 0),
            phases: Object.fromEntries(
              phases.map((phase) => {
                const cases = group.filter((record) => record.phase === phase);
                return [
                  phase,
                  {
                    medianBuildSeconds: median(cases.map((record) => record.buildSeconds)),
                    medianExportSeconds: median(cases.map((record) => record.exportSeconds)),
                    medianLocalCacheBytes: median(cases.map((record) => record.localCacheBytes)),
                  },
                ];
              }),
            ),
          },
        ];
      }),
    ),
  };
  save(join(directory, "comparison.json"), comparison);
  const lines = [
    "## API cache experiment",
    "",
    `Source: ${metrics.source}; run ${metrics.run}, attempt ${metrics.attempt}.`,
    "",
    "| Policy | Phase | Build median (s) | Export median (s) | Local cache median (bytes) |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  for (const [policy, value] of Object.entries(comparison.policies)) {
    for (const [phase, row] of Object.entries(value.phases))
      lines.push(
        `| ${policy} | ${phase} | ${row.medianBuildSeconds.toFixed(2)} | ${row.medianExportSeconds.toFixed(2)} | ${row.medianLocalCacheBytes} |`,
      );
  }
  lines.push(
    "",
    `Queue: ${queueSeconds === null ? "unknown for a rerun" : `${queueSeconds.toFixed(2)}s`}. Summed benchmark-worker time: ${summedWorkerSeconds.toFixed(2)}s.`,
    "",
    "Local cache bytes are builder storage, not remotely exported bytes. Repository cache storage is a shared, concurrently changing observation. main-only measures no PR export with no main cache available. Cache-only results do not measure release publication/scanning. Review complete chains before selecting a policy.",
  );
  writeFileSync(join(directory, "comparison.md"), `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function main(args) {
  const [command, ...values] = args;
  if (command === "prepare") prepare(...values);
  else if (command === "start") save(join(values[0], "start.json"), { at: Date.now() });
  else if (command === "collect") collect(values[0]);
  else if (command === "report") report(...values);
  else if (command === "progress")
    console.log(JSON.stringify(parseProgress(readFileSync(values[0], "utf8"))));
  else throw new Error("Unknown benchmark command");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
