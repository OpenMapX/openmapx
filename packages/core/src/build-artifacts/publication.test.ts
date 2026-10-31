import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { executionFingerprint } from "../ops/execution-identity";
import { DEFAULT_ARTIFACT_ARCHIVE_LIMITS, validateBuildBundle, writeBuildBundle } from "./archive";
import * as control from "./control-authority";
import { acquireArtifactTargetLease, closeArtifactTargetLeaseHandle } from "./target-lease";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse().splice(0)) close();
});
async function api() {
  expect(
    existsSync(join(import.meta.dirname, "publication.ts")),
    "journaled artifact publication is missing",
  ).toBe(true);
  return import("./publication");
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-artifact-publication-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "osrm-graph"), { mode: 0o755, recursive: true });
  writeFileSync(join(dataRoot, "osrm-graph/old"), "old graph", { mode: 0o644 });
  mkdirSync(join(dataRoot, ".openmapx-builds"), { mode: 0o755 });
  const oldRecord = JSON.stringify({
    schemaVersion: 1,
    service: "osrm",
    builtAt: "2026-01-01T00:00:00.000Z",
    runtimeImages: { osrm: "example/osrm:1" },
    toolImages: {},
  });
  writeFileSync(join(dataRoot, ".openmapx-builds/osrm.json"), oldRecord, { mode: 0o600 });
  const source = join(root, "source");
  mkdirSync(join(source, "osrm-graph"), { mode: 0o755, recursive: true });
  for (const file of [
    "region.osrm",
    "region.osrm.partition",
    "region.osrm.cells",
    "region.osrm.mldgr",
  ])
    writeFileSync(join(source, "osrm-graph", file), `new ${file}`, { mode: 0o644 });
  const chunks: Buffer[] = [];
  await writeBuildBundle({
    dataRoot: source,
    serviceId: "osrm",
    record: {
      schemaVersion: 1,
      service: "osrm",
      builtAt: "2026-10-30T00:00:00.000Z",
      runtimeImages: { osrm: "example/osrm:1" },
      toolImages: {},
    },
    target: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  const stageId = randomUUID(),
    stagingRoot = join(dataRoot, `.openmapx-import-${stageId}`);
  mkdirSync(stagingRoot, { mode: 0o700 });
  const bundle = await validateBuildBundle({
    source: Readable.from([Buffer.concat(chunks)]),
    stagingRoot,
    limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  await control.provisionControlInstallation(root);
  const installation = control.openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm"],
  });
  cleanup.push(() => control.closeControlInstallation(installation));
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 300000,
    operationKey = createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operation = {
      kind: "artifactTransfer.import",
      stageId,
      ownerId: "host-cli",
      expectedSha256: bundle.archiveSha256,
      previewFingerprint: "a".repeat(64),
      expectedCurrentRevisionId: null,
    },
    operationFingerprint = control.controlDigest(operation),
    execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey,
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    };
  const authority = control.retainAdmittedControlExecution(installation, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["osrm"],
    }),
    lease = await acquireArtifactTargetLease({ dataRoot, serviceIds: ["osrm"], owner: authority });
  cleanup.push(() => closeArtifactTargetLeaseHandle(lease));
  return { root, dataRoot, stagingRoot, stageId, bundle, authority, lease, oldRecord };
}
it("publishes dirs and build evidence under the original physical lease with a retained replay", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm");
  const input = { ...f, expectedFingerprint, signal: new AbortController().signal };
  const result = await mod.publishValidatedBuild(input);
  expect(result).toMatchObject({
    outcome: "committed",
    serviceId: "osrm",
    artifactFingerprint: f.bundle.artifactFingerprint,
    cleanupFailed: false,
  });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/region.osrm"), "utf8")).toBe("new region.osrm");
  expect(existsSync(join(f.dataRoot, "osrm-graph/old"))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(f.dataRoot, ".openmapx-builds/osrm.json"), "utf8")),
  ).toMatchObject({ schemaVersion: 2, artifactFingerprint: f.bundle.artifactFingerprint });
  expect(await mod.publishValidatedBuild(input)).toEqual(result);
}, 60000);
it("refuses a changed target before any rename or record write", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm");
  writeFileSync(join(f.dataRoot, "osrm-graph/old"), "changed old graph", { mode: 0o644 });
  expect(
    await mod.publishValidatedBuild({
      ...f,
      expectedFingerprint,
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ outcome: "not_committed", reason: "conflict" });
  expect(readFileSync(join(f.dataRoot, ".openmapx-builds/osrm.json"), "utf8")).toBe(f.oldRecord);
  expect(existsSync(join(f.stagingRoot, "osrm-graph"))).toBe(true);
}, 60000);
it("restores the old complete set after a native new-directory rename failure", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm"),
    newInode = fs.statSync(join(f.stagingRoot, "osrm-graph")).ino,
    native = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (fs.statSync(source).ino === newInode) throw Error("Named native publication failure");
    return native.renameSync(source, target);
  });
  expect(
    await mod.publishValidatedBuild({
      ...f,
      expectedFingerprint,
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ outcome: "not_committed", reason: "failed", cleanupFailed: false });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/old"), "utf8")).toBe("old graph");
  expect(readFileSync(join(f.dataRoot, ".openmapx-builds/osrm.json"), "utf8")).toBe(f.oldRecord);
}, 60000);

it("rejects undeclared staged files before beginning publication", async () => {
  const mod = await api(),
    f = await fixture();
  const expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm");
  writeFileSync(join(f.stagingRoot, "osrm-graph/undeclared"), "extra", { mode: 0o644 });
  expect(await mod.publishValidatedBuild({ ...f, expectedFingerprint })).toMatchObject({
    outcome: "not_committed",
    reason: "invalid",
  });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/old"), "utf8")).toBe("old graph");
  expect(
    control.readPrivateRecord(
      control.executionAuthorityState(f.authority).installation,
      "effect-started",
      `${f.lease.owner.operationKey}.json`,
    ),
  ).toBeNull();
}, 60000);

it("restores directories and old metadata when build-record publication fails", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm"),
    native = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (String(target).endsWith("/osrm.json") && String(source).includes(".write-"))
      throw Error("Named record publication failure");
    return native.renameSync(source, target);
  });
  expect(await mod.publishValidatedBuild({ ...f, expectedFingerprint })).toMatchObject({
    outcome: "not_committed",
    reason: "failed",
  });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/old"), "utf8")).toBe("old graph");
  expect(readFileSync(join(f.dataRoot, ".openmapx-builds/osrm.json"), "utf8")).toBe(f.oldRecord);
  expect(existsSync(join(f.dataRoot, ".openmapx-builds/osrm.evidence.json"))).toBe(false);
}, 60000);

it("keeps uncertain replacement fenced instead of overwriting a foreign inode during restoration", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm"),
    newInode = fs.statSync(join(f.stagingRoot, "osrm-graph")).ino,
    native = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (fs.statSync(source).ino === newInode) {
      mkdirSync(target, { mode: 0o755 });
      writeFileSync(join(String(target), "foreign"), "foreign", { mode: 0o644 });
      throw Error("External replacement during publication");
    }
    return native.renameSync(source, target);
  });
  await expect(mod.publishValidatedBuild({ ...f, expectedFingerprint })).rejects.toThrow(
    "restoration identity is uncertain",
  );
  expect(readFileSync(join(f.dataRoot, "osrm-graph/foreign"), "utf8")).toBe("foreign");
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  await expect(mod.publishValidatedBuild({ ...f, expectedFingerprint })).rejects.toThrow(
    "restoration identity is uncertain",
  );
  expect(readFileSync(join(f.dataRoot, ".openmapx-builds/osrm.json"), "utf8")).toBe(f.oldRecord);
}, 60000);

it("rechecks the original configuration revision inside the publication writer", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm");
  const { commitConfigurationGeneration } = await import("../services/configuration-generation");
  await commitConfigurationGeneration({
    infraDir: f.root,
    services: [],
    input: {
      domain: "changed.example.test",
      selectedRoots: [],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
  });
  expect(await mod.publishValidatedBuild({ ...f, expectedFingerprint })).toMatchObject({
    outcome: "not_committed",
    reason: "conflict",
  });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/old"), "utf8")).toBe("old graph");
}, 60000);

it("rejects same-size staged mutation after hashing instead of recording the previous hash as current", async () => {
  const mod = await api(),
    f = await fixture(),
    expectedFingerprint = await mod.artifactPublicationFingerprint(f.dataRoot, "osrm");
  expect(
    await mod.publishValidatedBuild({
      ...f,
      expectedFingerprint,
      beforePublication: async () => {
        const path = join(f.stagingRoot, "osrm-graph/region.osrm"),
          bytes = readFileSync(path);
        writeFileSync(path, Buffer.alloc(bytes.length, 120), { mode: 0o644 });
        return () => {};
      },
    }),
  ).toMatchObject({ outcome: "not_committed", reason: "conflict" });
  expect(readFileSync(join(f.dataRoot, "osrm-graph/old"), "utf8")).toBe("old graph");
}, 60000);
