import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it } from "vitest";
import { inspectMaintenanceDockerRuntime } from "./configuration-maintenance-docker-inspection";
import type { ConfigurationMaintenanceOwnerRecord } from "./configuration-maintenance-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(volumes = 3, secrets = 1, configs = 1) {
  const root = mkdtempSync(join(tmpdir(), "maintenance-mounts-"));
  roots.push(root);
  services.ensureReleaseStateDirectories(root);
  const revision = `cfg1_${"a".repeat(43)}`;
  const generation = join(root, services.CONFIGURATION_GENERATIONS, revision);
  mkdirSync(generation, { recursive: true, mode: 0o700 });
  writeFileSync(join(generation, services.GENERATED_COMPOSE_FILE), "services: {}\n", {
    mode: 0o600,
  });
  symlinkSync(`generations/${revision}`, join(root, services.CURRENT_CONFIGURATION));
  symlinkSync(
    `generations/${revision}`,
    join(root, services.CONFIGURATION_DIRECTORY, `.base-${revision}`),
  );
  const data = join(root, "data"),
    other = join(root, "other"),
    file = join(root, "private-file");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(file, "fixture-content", { mode: 0o600 });
  const id = "1".repeat(64),
    image = `sha256:${"2".repeat(64)}`,
    configHash = "3".repeat(64);
  const spec = {
    image: `example/app@sha256:${"4".repeat(64)}`,
    volumes: Array.from({ length: volumes }, (_, i) => ({
      type: "bind",
      source: data,
      target: `/data/${i}`,
      read_only: true,
    })),
    secrets: Array.from({ length: secrets }, (_, i) => ({ source: `secret-${i}` })),
    configs: Array.from({ length: configs }, (_, i) => ({
      source: `config-${i}`,
      target: `/config/${i}`,
    })),
  };
  const compose = {
    services: { "app-api": spec },
    secrets: Object.fromEntries(spec.secrets.map((s) => [s.source, { file }])),
    configs: Object.fromEntries(spec.configs.map((s) => [s.source, { file }])),
  };
  const observed = {
    Id: id,
    Image: image,
    HostConfig: { Memory: 0, NanoCpus: 0 },
    State: { Status: "running", Running: true },
    Config: {
      Image: spec.image,
      Labels: { "com.docker.compose.config-hash": configHash },
      Env: [],
    },
    Mounts: [
      ...spec.volumes.map((v) => ({
        Type: "bind",
        Source: v.source,
        Destination: v.target,
        RW: false,
      })),
      ...spec.secrets.map((s) => ({
        Type: "bind",
        Source: file,
        Destination: `/run/secrets/${s.source}`,
        RW: false,
      })),
      ...spec.configs.map((c) => ({
        Type: "bind",
        Source: file,
        Destination: c.target,
        RW: false,
      })),
    ],
  };
  const container = {
    serviceId: "app-api",
    containerId: id,
    state: "running" as const,
    provenance: {
      project: "openmapx",
      composeWorkingDirectory: generation,
      composeConfigFiles: [join(generation, services.GENERATED_COMPOSE_FILE)],
      imageId: image,
    },
  };
  // The inspector consumes already-admitted data; this fixture creates no authority.
  const owner = {
    receipt: { generation: "not_committed" },
    originalContainers: [container],
    plan: {
      operation: { revisionId: revision, expectedCurrentRevisionId: revision },
      steps: [],
      handoff: { serviceIds: ["app-api"] },
    },
  } as unknown as ConfigurationMaintenanceOwnerRecord;
  let content = "fixture-content";
  const readFiles: string[] = [];
  const inspect = () =>
    inspectMaintenanceDockerRuntime({
      stack: {
        infraDir: root,
        composePath: join(generation, services.GENERATED_COMPOSE_FILE),
        composeReleasePath: join(root, "unused-release.yml"),
      },
      owner,
      containers: [container],
      privateKey: key,
      signal: new AbortController().signal,
      execFile: async (_file, args) => {
        if (args[0] === "compose" && args.includes("--format"))
          return { stdout: JSON.stringify(compose), stderr: "" };
        if (args[0] === "compose" && args.includes("--hash"))
          return { stdout: `app-api ${configHash}`, stderr: "" };
        if (args[0] === "container" && args[1] === "inspect")
          return { stdout: JSON.stringify(observed), stderr: "" };
        if (args[0] === "container" && args[1] === "exec" && args[3] === "base64") {
          const target = args[4];
          if (!target) throw Error("Missing mounted-file target");
          readFiles.push(target);
          return { stdout: Buffer.from(content).toString("base64"), stderr: "" };
        }
        throw Error(`Unexpected Docker command: ${args.join(" ")}`);
      },
    });
  const { privateKey: key } = generateKeyPairSync("ed25519");
  return {
    inspect,
    spec,
    observed,
    readFiles,
    file,
    other,
    setContent: (value: string) => {
      content = value;
      writeFileSync(file, value);
    },
  };
}

it("retains a bounded digest of all 512 verified mounts, including secret/config contents", async () => {
  const f = fixture(256, 128, 128),
    result = await f.inspect();
  expect(result.checks.map((c) => c.check)).toEqual([
    "configuration",
    "image",
    "mount",
    "readiness",
  ]);
  expect(result.details[2]).toEqual({
    containerId: "1".repeat(64),
    mountCount: 512,
    mountsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(Buffer.byteLength(JSON.stringify(result.details[2]))).toBeLessThan(256);
  expect(f.readFiles).toHaveLength(256);
  expect(f.readFiles).toContain("/run/secrets/secret-127");
  expect(f.readFiles).toContain("/config/127");
});

it.each(["last-source", "access", "contents"])(
  "binds changes to %s in the mount-set digest",
  async (change) => {
    const f = fixture(),
      before = (await f.inspect()).details[2];
    const expected = f.spec.volumes[2],
      actual = f.observed.Mounts[2];
    if (!expected || !actual) throw Error("Missing fixture mount");
    if (change === "last-source") {
      expected.source = f.other;
      actual.Source = f.other;
    } else if (change === "access") {
      expected.read_only = false;
      actual.RW = true;
    } else f.setContent("changed-fixture-content");
    const after = (await f.inspect()).details[2];
    expect(after).toHaveProperty("mountCount", 5);
    expect(after).toHaveProperty("mountsDigest", expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(after).not.toEqual(before);
  },
);

it.each(["source", "access", "duplicate", "contents"])(
  "still refuses a mismatched mount %s",
  async (change) => {
    const f = fixture();
    const actual = f.observed.Mounts[2];
    if (!actual) throw Error("Missing fixture mount");
    if (change === "source") actual.Source = f.other;
    else if (change === "access") actual.RW = true;
    else if (change === "duplicate") f.observed.Mounts.push({ ...actual });
    else writeFileSync(f.file, "tampered-source");
    await expect(f.inspect()).rejects.toThrow(
      change === "contents"
        ? "Original runtime configuration/secret content differs"
        : /Original applied mount/,
    );
  },
);
