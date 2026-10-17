import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "docker-cache-benchmark.mjs");
const temporary: string[] = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-cache-benchmark-"));
  temporary.push(cwd);
  for (const [path, content] of Object.entries({
    "apps/api/src/server.ts": "export const server = true;\n",
    "apps/api/Dockerfile": "FROM scratch\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  })) {
    mkdirSync(resolve(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  const output = mkdtempSync(join(tmpdir(), "openmapx-cache-results-"));
  temporary.push(output);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_OUTPUT: join(output, "outputs"),
        ...env,
      },
    });
  return { cwd, output, run, git };
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("controlled cache experiment inputs", () => {
  it.each(["max", "min", "main-only"])(
    "isolates %s exports and bypasses imports on a cold refresh",
    (policy) => {
      const f = fixture();
      const result = f.run(["prepare", f.output, policy, "1", "cold"]);
      expect(result.status, result.stderr).toBe(0);
      const options = readFileSync(join(f.output, "outputs"), "utf8");
      expect(options).toContain("no-cache=true\n");
      expect(options).toContain("cache-from=\n");
      expect(options).toContain(`scope=ci-benchmark-api-123-2-${policy}-1`);
      if (policy === "main-only") expect(options).toContain("cache-to=\n");
      else
        expect(options).toContain(
          `cache-to=type=gha,version=2,mode=${policy},scope=ci-benchmark-api-123-2-${policy}-1`,
        );
      expect(f.git("diff", "--name-only")).toBe("");
    },
  );

  it("reuses only its own scope on the next build and records exact source inputs", () => {
    const f = fixture();
    expect(f.run(["prepare", f.output, "max", "2", "unchanged"]).status).toBe(0);
    const outputs = readFileSync(join(f.output, "outputs"), "utf8");
    expect(outputs).toContain("cache-from=type=gha,version=2,scope=ci-benchmark-api-123-2-max-2");
    expect(outputs).toContain("no-cache=false");
    const identity = JSON.parse(readFileSync(join(f.output, "unchanged/input.json"), "utf8"));
    expect(identity.sourceRevision).toBe(f.git("rev-parse", "HEAD").trim());
    expect(identity.sourceTree).toBe(f.git("rev-parse", "HEAD^{tree}").trim());
    expect(identity.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.diffSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes only the disposable API source for the source-only build", () => {
    const f = fixture();
    expect(f.run(["prepare", f.output, "min", "1", "source"]).status).toBe(0);
    expect(f.git("diff", "--name-only")).toBe("apps/api/src/server.ts\n");
    expect(readFileSync(join(f.cwd, "apps/api/src/server.ts"), "utf8")).toContain(
      "export const server = true;",
    );
    expect(f.run(["prepare", f.output, "min", "1", "source"]).status).not.toBe(0);
  });

  it("rejects a results directory inside the checkout even when its name begins with dots", () => {
    const f = fixture();
    expect(f.run(["prepare", join(f.cwd, "..results"), "max", "1", "cold"]).status).not.toBe(0);
    expect(f.git("status", "--porcelain")).toBe("");
  });

  it("rejects an output parent symlink that points back into the Docker context", () => {
    const f = fixture();
    symlinkSync(f.cwd, join(f.output, "alias"), "dir");
    expect(f.run(["prepare", join(f.output, "alias/results"), "max", "1", "cold"]).status).not.toBe(
      0,
    );
    expect(f.git("status", "--porcelain")).toBe("");
  });

  it.each([
    ["invalid", "1", "cold"],
    ["max\ncache-to=type=registry", "1", "cold"],
    ["max", "1", "../escape"],
    ["max", "0", "cold"],
  ])("rejects invalid configuration %j", (policy, sample, phase) => {
    const f = fixture();
    expect(f.run(["prepare", f.output, policy, sample, phase]).status).not.toBe(0);
    expect(existsSync(join(f.output, "outputs"))).toBe(false);
    expect(f.git("diff", "--name-only")).toBe("");
  });
});

describe("BuildKit progress measurements", () => {
  it("keeps vertex timings, excludes log payloads and avoids counting nested export twice", () => {
    const f = fixture();
    const raw = join(f.output, "raw.jsonl");
    writeFileSync(
      raw,
      [
        {
          id: "build",
          name: "[builder 1/1] RUN build",
          started: "2026-10-17T10:00:00Z",
          completed: "2026-10-17T10:00:10Z",
        },
        {
          id: "export",
          name: "exporting to GitHub Actions Cache",
          started: "2026-10-17T10:00:10Z",
          completed: "2026-10-17T10:00:30Z",
        },
        {
          id: "nested",
          name: "preparing build cache for export",
          started: "2026-10-17T10:00:11Z",
          completed: "2026-10-17T10:00:29Z",
        },
        { vertex: "build", stream: 1, data: "DO_NOT_RETAIN_LOG_PAYLOAD" },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    const result = f.run(["progress", raw]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.exportSeconds).toBe(20);
    expect(value.vertices).toHaveLength(3);
    expect(result.stdout).not.toContain("DO_NOT_RETAIN_LOG_PAYLOAD");
  });

  it("reads the real BuildKit aggregate vertex stream without retaining console payloads", () => {
    const f = fixture();
    const raw = join(f.output, "raw.jsonl");
    writeFileSync(
      raw,
      [
        { vertexes: [{ digest: "sha256:build", name: "COPY source" }] },
        {
          vertexes: [
            {
              digest: "sha256:build",
              started: "2026-10-17T10:00:00Z",
              completed: "2026-10-17T10:00:02Z",
            },
          ],
          logs: [{ data: "DO_NOT_RETAIN" }],
        },
        { vertexes: [{ digest: "sha256:build", name: "COPY source" }] },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    const result = f.run(["progress", raw]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).vertices).toEqual([
      { id: "sha256:build", name: "COPY source", seconds: 2, cached: false },
    ]);
    expect(result.stdout).not.toContain("DO_NOT_RETAIN");
  });

  it("merges repeated vertex updates without losing its start or cached flag", () => {
    const f = fixture();
    const raw = join(f.output, "raw.jsonl");
    writeFileSync(
      raw,
      [
        { id: "cached", name: "COPY source", started: "2026-10-17T10:00:00Z" },
        { id: "cached", completed: "2026-10-17T10:00:02Z", cached: true },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    const result = f.run(["progress", raw]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).vertices).toEqual([
      { id: "cached", name: "COPY source", seconds: 2, cached: true },
    ]);
  });

  it.each([
    "not-json",
    JSON.stringify({ logs: "unrecognized schema" }),
    JSON.stringify({
      id: "x",
      name: "exporting to GitHub Actions Cache",
      started: "bad",
      completed: "bad",
    }),
  ])(
    "rejects missing or malformed timing evidence rather than reporting a zero export: %s",
    (contents) => {
      const f = fixture();
      const raw = join(f.output, "raw.jsonl");
      writeFileSync(raw, contents);
      expect(f.run(["progress", raw]).status).not.toBe(0);
    },
  );
});

describe("cache policy comparison", () => {
  function comparison() {
    const f = fixture();
    for (const policy of ["max", "min", "main-only"]) {
      for (const phase of ["cold", "unchanged", "source"]) {
        const directory = join(f.output, policy, phase);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "result.json"),
          JSON.stringify({
            policy,
            phase,
            sample: "1",
            run: "123",
            attempt: "1",
            sourceRevision: "a".repeat(40),
            sourceTree: "b".repeat(40),
            lockfileSha256: "c".repeat(64),
            dockerfileSha256: "d".repeat(64),
            diffSha256: (phase === "source" ? "e" : "f").repeat(64),
            buildx: "buildx v0.38.0",
            node: "v24.21.0",
            runnerImage: "20261017",
            configuredBuildkitImage: "moby/buildkit@sha256:pin",
            configuredFrontend: "docker/dockerfile@sha256:pin",
            configuredSbomGenerator: "docker/scanner@sha256:pin",
            actionSeconds: 12,
            buildSeconds: 10,
            exportSeconds: policy === "main-only" ? 0 : 4,
            localCacheBytes: 100,
            cachedSteps: phase === "unchanged" ? 4 : 0,
            totalSteps: 5,
            materials: [{ URI: "pkg:docker/node", Digests: [`sha256:${"a".repeat(64)}`] }],
          }),
        );
      }
    }
    writeFileSync(
      join(f.output, "job-metrics.json"),
      JSON.stringify({
        source: "a".repeat(40),
        run: 123,
        attempt: 1,
        createdAt: "2026-10-17T10:00:00Z",
        startedAt: "2026-10-17T10:00:05Z",
        repositoryCacheBytesObserved: 500,
        jobs: ["max", "min", "main-only"].map((policy) => ({
          name: `Benchmark ${policy} / sample 1`,
          status: "completed",
          conclusion: "success",
          startedAt: "2026-10-17T10:00:05Z",
          completedAt: "2026-10-17T10:01:05Z",
        })),
      }),
    );
    return f;
  }

  it("reports each complete chain, runner cost and queue delay without declaring a winner", () => {
    const f = comparison();
    const result = f.run(["report", f.output, "1"], { MATRIX_RESULT: "success" });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(f.output, "comparison.json"), "utf8"));
    expect(report.queueSeconds).toBe(5);
    expect(report.summedWorkerSeconds).toBe(180);
    expect(report.policies.max.totalActionSeconds).toBe(36);
    expect(report.policies.max.phases.unchanged.medianBuildSeconds).toBe(10);
    expect(report.policies.max.phases.cold.medianExportSeconds).toBe(4);
    expect(report).not.toHaveProperty("winner");
  });

  it.each([
    { materials: [] },
    { materials: [{ URI: "", Digests: [`sha256:${"a".repeat(64)}`] }] },
    { materials: [{ URI: "pkg:docker/node", Digests: [] }] },
    { materials: [{ URI: "pkg:docker/node", Digests: [""] }] },
  ])("rejects equally incomplete resolved materials in every receipt: %j", ({ materials }) => {
    const f = comparison();
    for (const policy of ["max", "min", "main-only"]) {
      for (const phase of ["cold", "unchanged", "source"]) {
        const path = join(f.output, policy, phase, "result.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        record.materials = materials;
        writeFileSync(path, JSON.stringify(record));
      }
    }
    const result = f.run(["report", f.output, "1"], { MATRIX_RESULT: "success" });
    expect(result.status, result.stderr).not.toBe(0);
    expect(existsSync(join(f.output, "comparison.json"))).toBe(false);
  });

  it("reports rerun queue delay as unknown instead of including the time between attempts", () => {
    const f = comparison();
    for (const policy of ["max", "min", "main-only"]) {
      for (const phase of ["cold", "unchanged", "source"]) {
        const path = join(f.output, policy, phase, "result.json");
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.attempt = "2";
        writeFileSync(path, JSON.stringify(value));
      }
    }
    const path = join(f.output, "job-metrics.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.attempt = 2;
    writeFileSync(path, JSON.stringify(value));
    const result = f.run(["report", f.output, "1"], { MATRIX_RESULT: "success" });
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(f.output, "comparison.json"), "utf8")).queueSeconds,
    ).toBeNull();
  });

  it.each([
    "missing",
    "duplicate",
    "source",
    "toolchain",
    "material",
    "matrix",
    "job",
    "missing-toolchain",
    "source-noop",
  ])("rejects %s evidence before computing an apparently complete comparison", (fault) => {
    const f = comparison();
    const path = join(f.output, "max/cold/result.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (fault === "missing") rmSync(path);
    if (fault === "duplicate") {
      mkdirSync(join(f.output, "duplicate"));
      writeFileSync(join(f.output, "duplicate/result.json"), JSON.stringify(record));
    }
    if (fault === "source") record.sourceRevision = "9".repeat(40);
    if (fault === "toolchain") record.buildx = "different";
    if (fault === "material") record.materials[0].Digests = ["sha256:different"];
    if (["source", "toolchain", "material"].includes(fault))
      writeFileSync(path, JSON.stringify(record));
    if (["missing-toolchain", "source-noop"].includes(fault)) {
      for (const policy of ["max", "min", "main-only"]) {
        for (const phase of ["cold", "unchanged", "source"]) {
          const file = join(f.output, policy, phase, "result.json");
          const value = JSON.parse(readFileSync(file, "utf8"));
          if (fault === "missing-toolchain") delete value.buildx;
          if (fault === "source-noop") value.diffSha256 = "f".repeat(64);
          writeFileSync(file, JSON.stringify(value));
        }
      }
    }
    if (fault === "job") {
      const metrics = JSON.parse(readFileSync(join(f.output, "job-metrics.json"), "utf8"));
      metrics.jobs[0].conclusion = "cancelled";
      writeFileSync(join(f.output, "job-metrics.json"), JSON.stringify(metrics));
    }
    expect(
      f.run(["report", f.output, "1"], {
        MATRIX_RESULT: fault === "matrix" ? "failure" : "success",
      }).status,
    ).not.toBe(0);
    expect(existsSync(join(f.output, "comparison.json"))).toBe(false);
  });
});
