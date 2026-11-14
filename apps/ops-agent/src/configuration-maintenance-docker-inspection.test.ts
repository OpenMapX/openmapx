import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it } from "vitest";
import {
  acquireReleaseStoreLockBriefly,
  awaitAppliedContainerHealth,
  inspectMaintenanceDockerRuntime,
} from "./configuration-maintenance-docker-inspection";
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

it("waits briefly for another holder of the release store lock", async () => {
  const store = mkdtempSync(join(tmpdir(), "openmapx-release-store-"));
  try {
    const held = await services.acquireReleaseStoreLock(store);
    setTimeout(() => held.release(), 300);
    const started = Date.now();
    const lock = await acquireReleaseStoreLockBriefly(store);
    lock.release();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

it("still refuses the release store lock while another holder keeps it", async () => {
  const store = mkdtempSync(join(tmpdir(), "openmapx-release-store-"));
  try {
    const held = await services.acquireReleaseStoreLock(store);
    const started = Date.now();
    await expect(acquireReleaseStoreLockBriefly(store)).rejects.toThrow("Release store is busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    held.release();
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

it("refuses an applied container whose healthcheck has not passed, naming its service", async () => {
  const { inspect, observed } = fixture(1, 0, 0);
  Object.assign(observed.State, { Health: { Status: "starting" } });
  await expect(inspect()).rejects.toThrow("Original applied container not ready: app-api");
});

it("waits for a recreated container's healthcheck before it is checked", async () => {
  const answers = ["starting", "starting", "healthy"];
  const asked: (readonly string[])[] = [];
  await awaitAppliedContainerHealth({
    containerId: "1".repeat(64),
    deadlineAt: Date.now() + 60_000,
    pollMs: 1,
    signal: new AbortController().signal,
    execFile: async (_file, args) => {
      asked.push(args);
      return { stdout: `${answers.shift() ?? "healthy"}\n`, stderr: "" };
    },
  });
  expect(asked).toHaveLength(3);
  expect(asked[0]).toEqual([
    "container",
    "inspect",
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    "1".repeat(64),
  ]);
});

it("stops waiting at once for a container without a healthcheck or one already unhealthy", async () => {
  for (const status of ["none", "unhealthy", "healthy"]) {
    let calls = 0;
    await awaitAppliedContainerHealth({
      containerId: "1".repeat(64),
      deadlineAt: Date.now() + 60_000,
      pollMs: 1,
      signal: new AbortController().signal,
      execFile: async () => {
        calls++;
        return { stdout: status, stderr: "" };
      },
    });
    expect(calls, status).toBe(1);
  }
});

it("stops waiting at its deadline and leaves the refusal to the readiness check", async () => {
  let calls = 0;
  const started = Date.now();
  await awaitAppliedContainerHealth({
    containerId: "1".repeat(64),
    deadlineAt: Date.now() + 50,
    pollMs: 5,
    signal: new AbortController().signal,
    execFile: async () => {
      calls++;
      return { stdout: "starting", stderr: "" };
    },
  });
  expect(calls).toBeGreaterThan(1);
  expect(Date.now() - started).toBeLessThan(5_000);
});

// The helper and the agent see only the checkout's mounts; a host path outside
// it, such as the default Docker configuration directory, does not resolve.
const unseen = "/nonexistent-openmapx-host/root/.docker";

it("compares a bind source outside the checkout that it cannot see by its path", async () => {
  const { inspect, spec, observed } = fixture(1, 0, 0);
  (spec.volumes[0] as { source: string }).source = unseen;
  (observed.Mounts[0] as { Source: string }).Source = unseen;
  const first = await inspect();
  expect(first.checks.some((check) => check.check === "mount")).toBe(true);
  // The evidence is stable, so the same mount verifies the same way again.
  expect((await inspect()).details).toEqual(first.details);
});

it("still refuses a changed bind source outside the checkout that it cannot see", async () => {
  const { inspect, spec, observed } = fixture(1, 0, 0);
  (spec.volumes[0] as { source: string }).source = unseen;
  (observed.Mounts[0] as { Source: string }).Source = "/nonexistent-openmapx-host/elsewhere";
  await expect(inspect()).rejects.toThrow("Original applied mount source differs");
});

it("still resolves a bind source it can see and refuses a missing one inside the checkout", async () => {
  const { inspect, spec, observed, other } = fixture(1, 0, 0);
  (observed.Mounts[0] as { Source: string }).Source = other;
  await expect(inspect()).rejects.toThrow("Original applied mount source differs");
  const missing = fixture(1, 0, 0);
  const inside = join(missing.other, "missing");
  (missing.spec.volumes[0] as { source: string }).source = inside;
  (missing.observed.Mounts[0] as { Source: string }).Source = inside;
  await expect(missing.inspect()).rejects.toThrow("ENOENT");
});
