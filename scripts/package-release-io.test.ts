import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageReleaseSourceFixture } from "./fixtures/package-release-source";
import { planPackageRelease } from "./package-release.mjs";
import {
  createPackageReleasePorts,
  readPackageCandidate,
  verifyPackageProvenance,
  writePackageCandidate,
} from "./package-release-io.mjs";

const dirs: string[] = [];
const source = "a".repeat(40);
const context = {
  repository: "OpenMapX/openmapx",
  sha: source,
  ref: "refs/heads/main",
  workflowRef: "OpenMapX/openmapx/.github/workflows/package-release.yml@refs/heads/main",
  runId: 100,
  attempt: 1,
};
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-package-io-"));
  dirs.push(cwd);
  const packages = ["extension-contracts", "extension-cli"].map((slug) => ({
    name: `@openmapx/${slug}`,
    directory: `packages/${slug}`,
    version: "0.1.0",
    private: false,
    dependencies: {},
  }));
  const batch = planPackageRelease({
    operation: "qualify",
    context,
    toolVersion: "3.0.3",
    packages,
    pending: [],
    nativePlan: { version: 1, plan: [] },
  });
  mkdirSync(join(cwd, "packages"));
  const items = packages.map((item) => {
    const staging = join(cwd, item.name.split("/")[1]);
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(
      join(staging, "package/package.json"),
      JSON.stringify({
        ...item,
        repository: {
          type: "git",
          url: "git+https://github.com/OpenMapX/openmapx.git",
          directory: item.directory,
        },
        homepage: "https://github.com/OpenMapX/openmapx",
      }),
    );
    const path = `packages/${item.name.split("/")[1]}.tgz`;
    execFileSync("tar", ["-czf", join(cwd, path), "-C", staging, "package"]);
    rmSync(staging, { recursive: true });
    return { ...item, path, selected: true };
  });
  writeFileSync(join(cwd, "publish-plan.json"), JSON.stringify({ version: 1, plan: [] }));
  return { cwd, batch, items };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function candidate() {
  const f = fixture();
  const receipt = writePackageCandidate({
    directory: f.cwd,
    batch: f.batch,
    items: f.items,
    tools: { changesets: "3.0.3", npm: "11.19.0", pnpm: "12.11.2", node: "v24.21.0" },
  });
  return { ...f, receipt };
}
function statement(item: { name: string; version: string; sha512: string }) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `${item.name === "@openmapx/extension-contracts" ? "pkg:npm/%40openmapx/extension-contracts" : "pkg:npm/%40openmapx/extension-cli"}@${item.version}`,
        digest: { sha512: item.sha512 },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: "https://github.com/OpenMapX/openmapx",
            path: ".github/workflows/package-release.yml",
            ref: "refs/heads/main",
          },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/OpenMapX/openmapx@refs/heads/main",
            digest: { gitCommit: source },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/OpenMapX/openmapx/actions/runs/100/attempts/1",
        },
      },
    },
  };
}
describe("immutable candidate receipt and exact bytes", () => {
  it("reads the exact paths and SHA512 bytes without repacking", () => {
    const f = candidate();
    const result = readPackageCandidate({
      directory: f.cwd,
      expectedHash: f.receipt.hash,
      context,
    });
    expect(result.packages.map((p: { path: string }) => p.path)).toEqual(
      f.items.map((p) => join(f.cwd, p.path)),
    );
    for (const p of result.packages)
      expect(p.integrity).toBe(
        `sha512-${createHash("sha512").update(readFileSync(p.path)).digest("base64")}`,
      );
  });
  it.each(["tarball", "plan", "receipt", "extra", "symlink"])(
    "rejects %s mutation after approval",
    (kind) => {
      const f = candidate();
      if (kind === "tarball") writeFileSync(join(f.cwd, f.items[0].path), "modified");
      if (kind === "plan") writeFileSync(join(f.cwd, "publish-plan.json"), "{}");
      if (kind === "receipt") {
        const r = JSON.parse(readFileSync(join(f.cwd, "receipt.json"), "utf8"));
        r.batch.context.attempt++;
        writeFileSync(join(f.cwd, "receipt.json"), JSON.stringify(r));
      }
      if (kind === "extra") writeFileSync(join(f.cwd, "unexpected.tgz"), "extra");
      if (kind === "symlink") {
        rmSync(join(f.cwd, f.items[0].path));
        symlinkSync("/etc/hosts", join(f.cwd, f.items[0].path));
      }
      expect(() =>
        readPackageCandidate({ directory: f.cwd, expectedHash: f.receipt.hash, context }),
      ).toThrow();
    },
  );
  it.each([
    "../escape.tgz",
    "/tmp/escape.tgz",
    "packages/../escape.tgz",
    "packages/nested/escape.tgz",
  ])("rejects unsafe candidate path %s", (path) => {
    const f = fixture();
    f.items[0].path = path;
    expect(() =>
      writePackageCandidate({ directory: f.cwd, batch: f.batch, items: f.items, tools: {} }),
    ).toThrow(/path/i);
  });
  it("rejects a companion marked for publication", () => {
    const f = fixture();
    f.batch.selected = [f.batch.selected[0]];
    expect(() =>
      writePackageCandidate({ directory: f.cwd, batch: f.batch, items: f.items, tools: {} }),
    ).toThrow(/selected|companion/);
  });
  it("rejects wrong source/run/attempt and candidate hash", () => {
    const f = candidate();
    for (const wrong of [
      { ...context, sha: "b".repeat(40) },
      { ...context, runId: 101 },
      { ...context, attempt: 2 },
    ])
      expect(() =>
        readPackageCandidate({ directory: f.cwd, expectedHash: f.receipt.hash, context: wrong }),
      ).toThrow();
    expect(() =>
      readPackageCandidate({ directory: f.cwd, expectedHash: "0".repeat(64), context }),
    ).toThrow();
  });
});
function ioProbe(f: ReturnType<typeof candidate>, input: Record<string, unknown>) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "fixtures/package-release-io-probe.mjs")],
      {
        input: JSON.stringify({
          directory: f.cwd,
          expectedHash: f.receipt.hash,
          context,
          ...input,
        }),
        encoding: "utf8",
        timeout: 3000,
      },
    ),
  );
}
describe("bounded descriptor JSON reads", () => {
  it("never reads a replacement target after checking the original receipt", () => {
    const f = candidate();
    const result = ioProbe(f, { mode: "replacement" });
    expect(result.replacementRead).toBe(false);
    expect(result.unboundedRead).toBe(false);
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
  });
  it("rejects post-stat growth after reading at most limit plus one bytes and closes the descriptor", () => {
    const result = ioProbe(candidate(), { mode: "growth" });
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/bounded/i);
    expect(result.bytesRead).toBe(128 * 1024 + 1);
    expect(result.maxReadRequest).toBeLessThanOrEqual(128 * 1024 + 1);
    expect(result.unboundedRead).toBe(false);
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
  });
  it("detects post-stat growth even when the resulting JSON is below the limit", () => {
    const result = ioProbe(candidate(), { mode: "small-growth" });
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/changed during bounded read/);
    expect(result.bytesRead).toBeLessThanOrEqual(128 * 1024 + 1);
    expect(result.unboundedRead).toBe(false);
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
  });
  it("rejects FIFO receipts without blocking or leaking the descriptor", () => {
    const result = ioProbe(candidate(), { mode: "fifo" });
    expect(result.error).toMatch(/bounded/i);
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
    expect(result.bytesRead).toBe(0);
  });
  it("closes the receipt descriptor on a successful read", () => {
    const result = ioProbe(candidate(), {});
    expect(result.error).toBeNull();
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
    expect(result.unboundedRead).toBe(false);
  });
  it.each(["oversized", "symlink", "malformed"])("rejects %s receipt JSON", (kind) => {
    const f = candidate();
    const path = join(f.cwd, "receipt.json");
    if (kind === "oversized") writeFileSync(path, " ".repeat(128 * 1024 + 1));
    if (kind === "malformed") writeFileSync(path, "{");
    if (kind === "symlink") {
      rmSync(path);
      symlinkSync(join(f.cwd, "publish-plan.json"), path);
    }
    const result = ioProbe(f, {});
    expect(result.error).not.toBeNull();
    expect(result.closed).toBe(result.opened);
    expect(result.unboundedRead).toBe(false);
  });
});
describe("tar member validation through candidate reads", () => {
  it("rejects adversarial plus repetitions within a bounded child process", () => {
    const result = ioProbe(candidate(), {
      members: ["package/package.json", `package/${"+".repeat(10000)}!`],
    });
    expect(result.error).toMatch(/Unsafe tar member/);
  });
  it("accepts the package root, nested schema names and optional trailing slash", () => {
    const result = ioProbe(candidate(), {
      members: [
        "package/",
        "package/package.json",
        "package/schemas/@scope/a_b-1.2+3.json",
        "package/dist/",
      ],
    });
    expect(result.error).toBeNull();
  });
  it.each([
    "package//bad",
    "package/a//b",
    "package/./bad",
    "package/../bad",
    "/package/bad",
    "package/a b",
    "package/a\\b",
    "package//",
  ])("rejects unsafe member %s", (member) => {
    expect(ioProbe(candidate(), { members: ["package/package.json", member] }).error).toMatch(
      /Unsafe tar member/,
    );
  });
});
describe("explicit private candidate storage", () => {
  it("requires an explicit directory only when a candidate operation is requested", async () => {
    vi.stubEnv("PACKAGE_ARTIFACT_DIRECTORY", undefined);
    try {
      const run = vi.fn(() => {
        throw new Error("must not execute a command");
      });
      const ports = createPackageReleasePorts({ run });
      await expect(ports.readCandidate({ candidateHash: "a".repeat(64), context })).rejects.toThrow(
        /explicit.*directory/i,
      );
      await expect(ports.qualify({}, {})).rejects.toThrow(/explicit.*directory/i);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not write to an implicit predictable temporary directory", async () => {
    const f = fixture();
    vi.stubEnv("TMPDIR", f.cwd);
    vi.stubEnv("PACKAGE_ARTIFACT_DIRECTORY", undefined);
    const before = readdirSync(f.cwd);
    try {
      const ports = createPackageReleasePorts({
        run() {
          throw new Error("must not execute");
        },
      });
      await expect(ports.qualify({}, {})).rejects.toThrow(/explicit.*directory/i);
      expect(readdirSync(f.cwd)).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("creates an explicit fresh directory privately and refuses an existing directory", async () => {
    const f = fixture();
    const directory = join(f.cwd, "candidate");
    const ports = createPackageReleasePorts({
      directory,
      run() {
        throw new Error("stop after directory creation");
      },
    });
    await expect(ports.qualify({}, {})).rejects.toThrow("stop after directory creation");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    writeFileSync(join(directory, "receipt.json"), "preserve existing receipt");
    await expect(ports.qualify({}, {})).rejects.toThrow(/already exists/i);
    expect(readFileSync(join(directory, "receipt.json"), "utf8")).toBe("preserve existing receipt");
  });
  it("writes a private exclusive receipt and preserves it on a second write", () => {
    const f = candidate();
    const path = join(f.cwd, "receipt.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path);
    expect(() =>
      writePackageCandidate({ directory: f.cwd, batch: f.batch, items: f.items, tools: {} }),
    ).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it("reads candidates from an explicit options directory", async () => {
    const f = candidate();
    const ports = createPackageReleasePorts({ directory: f.cwd });
    await expect(
      ports.readCandidate({ candidateHash: f.receipt.hash, context }),
    ).resolves.toMatchObject({ hash: f.receipt.hash });
  });
});
describe("public registry adapter fails closed", () => {
  it.each([401, 403, 500, 429])(
    "rejects HTTP %s without treating it as absence",
    async (status) => {
      const fetch = vi.fn(async () => new Response("denied", { status }));
      const ports = createPackageReleasePorts({ fetch });
      await expect(
        ports.registryVersion({ name: "@openmapx/extension-cli", version: "0.1.0" }),
      ).rejects.toThrow(/registry/);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it("requires separately authorized bootstrap on whole-package 404", async () => {
    const ports = createPackageReleasePorts({
      fetch: async () => new Response("{}", { status: 404 }),
    });
    await expect(
      ports.registryVersion({ name: "@openmapx/extension-cli", version: "0.1.0" }),
    ).rejects.toThrow(/bootstrap/i);
  });
  it("distinguishes absent exact version from a missing package", async () => {
    const ports = createPackageReleasePorts({
      fetch: async () => Response.json({ name: "@openmapx/extension-cli", versions: {} }),
    });
    await expect(
      ports.registryVersion({ name: "@openmapx/extension-cli", version: "0.1.0" }),
    ).resolves.toBeNull();
  });
  it.each(["network", "malformed"])("rejects %s failure", async (kind) => {
    const ports = createPackageReleasePorts({
      fetch: async () => {
        if (kind === "network") throw new Error("network");
        return new Response("garbage");
      },
    });
    await expect(
      ports.registryVersion({ name: "@openmapx/extension-cli", version: "0.1.0" }),
    ).rejects.toThrow();
  });
});
describe("verified public provenance identity", () => {
  it.each([
    ["@openmapx/extension-contracts", "pkg:npm/%40openmapx/extension-contracts@0.1.0"],
    ["@openmapx/extension-cli", "pkg:npm/%40openmapx/extension-cli@0.1.0"],
  ])("accepts the canonical npm PURL for %s", (name, purl) => {
    const f = candidate();
    const item = f.receipt.items.find((p: { name: string }) => p.name === name);
    const attestation = statement(item);
    expect(attestation.subject[0].name).toBe(purl);
    expect(() => verifyPackageProvenance(attestation, item, f.batch)).not.toThrow();
  });
  it.each(["repository", "workflow", "source", "subject", "event", "builder"])(
    "rejects wrong provenance %s",
    (field) => {
      const f = candidate();
      const item = f.receipt.items[0];
      const s = statement(item);
      if (field === "repository")
        s.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/other/repo";
      if (field === "workflow")
        s.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml";
      if (field === "source")
        s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
      if (field === "subject") s.subject[0].digest.sha512 = "b".repeat(128);
      if (field === "event")
        s.predicate.buildDefinition.internalParameters.github.event_name = "pull_request";
      if (field === "builder") s.predicate.runDetails.builder.id = "https://other/builder";
      expect(() => verifyPackageProvenance(s, item, f.batch)).toThrow(/provenance/i);
    },
  );
});

describe("production npm and GitHub command ports with injected external systems", () => {
  function adapter(lockPadding = 0) {
    const f = candidate();
    const item = f.receipt.items[0];
    const calls: { executable: string; args: string[] }[] = [];
    let auditResult: unknown = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: item.name,
          version: item.version,
          registry: "https://registry.npmjs.org/",
          attestationBundles: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                dsseEnvelope: {
                  payloadType: "application/vnd.in-toto+json",
                  payload: Buffer.from(JSON.stringify(statement(item))).toString("base64"),
                },
              },
            },
          ],
        },
      ],
    };
    let tag: string | null = null;
    const run = (
      executable: string,
      args: string[],
      options: { cwd?: string; input?: string; env?: Record<string, string> } = {},
    ) => {
      calls.push({ executable, args });
      if (executable === "npm") {
        if (args[0] === "--version") return "11.19.0";
        if (args[0] === "install") {
          writeFileSync(
            join(options.cwd ?? "", "package-lock.json"),
            JSON.stringify({
              packages: { [`node_modules/${item.name}`]: { integrity: item.integrity } },
            }) + " ".repeat(lockPadding),
          );
          return "";
        }
        if (args[0] === "audit") return JSON.stringify(auditResult);
        if (args[0] === "publish") return "";
      }
      if (executable === "gh") {
        const path = args[1];
        if (path.includes("matching-refs"))
          return JSON.stringify(
            tag
              ? [
                  {
                    ref: `refs/tags/${item.name}@${item.version}`,
                    object: { type: "commit", sha: tag },
                  },
                ]
              : [],
          );
        if (args.includes("POST")) {
          const body = JSON.parse(options.input ?? "{}");
          expect(body).toEqual({ ref: `refs/tags/${item.name}@${item.version}`, sha: source });
          tag = body.sha;
          return "{}";
        }
      }
      return execFileSync(executable, args, { encoding: "utf8", ...options }).trim();
    };
    const metadata = {
      name: item.name,
      version: item.version,
      dist: {
        integrity: item.integrity,
        tarball: "https://registry.npmjs.org/candidate.tgz",
        attestations: { url: "https://registry.npmjs.org/attestations" },
      },
    };
    const ports = createPackageReleasePorts({
      cwd: f.cwd,
      directory: f.cwd,
      run,
      fetch: async () => new Response(readFileSync(join(f.cwd, item.path))),
    });
    return {
      ...f,
      item: { ...item, path: join(f.cwd, item.path) },
      metadata,
      calls,
      ports,
      audit: (data: unknown) => {
        auditResult = data;
      },
      tag: (value: string) => {
        tag = value;
      },
    };
  }
  it("checks downloaded bytes and the CLI's cryptographically verified bundle", async () => {
    const f = adapter();
    await f.ports.verifyPublished(f.item, f.metadata, f.batch);
    expect(f.calls.filter((c) => c.executable === "npm").map((c) => c.args[0])).toEqual([
      "install",
      "audit",
    ]);
    expect(f.calls.find((c) => c.args[0] === "install")?.args).toContain("--ignore-scripts");
    expect(f.calls.find((c) => c.args[0] === "audit")?.args).toContain("--include-attestations");
  });
  it("accepts an installed lockfile above the receipt limit but below the 4 MiB limit", async () => {
    const f = adapter(256 * 1024);
    await expect(f.ports.verifyPublished(f.item, f.metadata, f.batch)).resolves.toBeUndefined();
  });
  it("rejects an installed lockfile above the 4 MiB bound", async () => {
    const f = adapter(4 * 1024 * 1024);
    await expect(f.ports.verifyPublished(f.item, f.metadata, f.batch)).rejects.toThrow(/bounded/);
  });
  it.each(["absent", "invalid", "wrong subject"])(
    "rejects %s verified audit output",
    async (kind) => {
      const f = adapter();
      f.audit(
        kind === "invalid"
          ? { invalid: [{}], missing: [] }
          : kind === "absent"
            ? { invalid: [], missing: [], verified: [] }
            : {
                invalid: [],
                missing: [],
                verified: [
                  {
                    name: f.item.name,
                    version: f.item.version,
                    registry: "https://registry.npmjs.org/",
                    attestationBundles: [],
                  },
                ],
              },
      );
      await expect(f.ports.verifyPublished(f.item, f.metadata, f.batch)).rejects.toThrow();
    },
  );
  it("rejects conflicting integrity before install or publication", async () => {
    const f = adapter();
    f.metadata.dist.integrity = "sha512-conflict";
    await expect(f.ports.verifyPublished(f.item, f.metadata, f.batch)).rejects.toThrow(/integrity/);
    expect(f.calls).toEqual([]);
  });
  it("publishes the same tarball with all lifecycle scripts disabled", async () => {
    const f = adapter();
    await f.ports.publishTarball(f.item);
    expect(f.calls).toEqual([
      {
        executable: "npm",
        args: [
          "publish",
          f.item.path,
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "latest",
          "--provenance",
          "--registry",
          "https://registry.npmjs.org",
        ],
      },
    ]);
  });
  it("creates and reads back only the exact package ref, then leaves it alone", async () => {
    const f = adapter();
    await f.ports.createTag(f.item, source);
    await f.ports.createTag(f.item, source);
    expect(f.calls.filter((c) => c.args.includes("POST"))).toHaveLength(1);
    expect(
      f.calls.some((c) => c.args.includes("--follow-tags") || c.args.includes("--force")),
    ).toBe(false);
  });
  it("rejects a conflicting existing tag without remote writes", async () => {
    const f = adapter();
    f.tag("b".repeat(40));
    await expect(f.ports.createTag(f.item, source)).rejects.toThrow(/tag/);
    expect(f.calls.filter((c) => c.args.includes("POST"))).toHaveLength(0);
  });
});

describe("actual canonical merged-PR source inspection", () => {
  it("replays the real reviewed head and later squash merge against actual Git data", async () => {
    const f = packageReleaseSourceFixture();
    dirs.push(f.cwd);
    const ports = createPackageReleasePorts({
      cwd: f.cwd,
      run: f.run,
      fetch: async () => Response.json({ name: "@openmapx/extension-contracts", versions: {} }),
    });
    const sourceData = await ports.inspectSource(f.request);
    expect(
      planPackageRelease(sourceData).selected.map((p: { name: string; version: string }) => [
        p.name,
        p.version,
      ]),
    ).toEqual([["@openmapx/extension-contracts", "0.1.1"]]);
    expect(f.calls).toContain("repos/OpenMapX/openmapx/actions/runs/90/attempts/2");
  });
  it("rejects real source tampering in a merged version PR before candidate packing", async () => {
    const f = packageReleaseSourceFixture(true);
    dirs.push(f.cwd);
    const fetch = vi.fn();
    const ports = createPackageReleasePorts({ cwd: f.cwd, run: f.run, fetch });
    await expect(ports.inspectSource(f.request)).rejects.toThrow(/Canonical/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
