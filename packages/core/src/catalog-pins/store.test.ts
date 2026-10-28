import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync), renameSync: vi.fn(actual.renameSync) };
});

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ControlInstallation,
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
} from "../build-artifacts/control-authority";
import {
  type ArtifactTargetLease,
  acquireArtifactTargetLease,
  closeArtifactTargetLeaseHandle,
} from "../build-artifacts/target-lease";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { createCatalogPinSet } from "./generation";
import {
  initializeCatalogPinSet,
  publishCatalogPinSet,
  readCatalogPinCommit,
  readCatalogPinSet,
} from "./store";
import type { CatalogPinCommitIdentity } from "./types";

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string, docker: string, installation: ControlInstallation, lease: ArtifactTargetLease;
const transitous = {
  ref: `main@${"a".repeat(40)}`,
  submodules: { "transitland-atlas": "b".repeat(40) },
  lockedAt: "2026-10-23T00:00:00.000Z",
  lockedBy: "fixture",
};
const gbfs = {
  schemaVersion: 1 as const,
  source: "mobilitydata-gbfs" as const,
  commit: "c".repeat(40),
  url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
  sha256: "d".repeat(64),
  lockedAt: transitous.lockedAt,
  lockedBy: "fixture",
};
function legacy() {
  writeFileSync(
    join(docker, "transitous.lock.json"),
    JSON.stringify({ $schema: "legacy", ...transitous }),
  );
  writeFileSync(
    join(docker, "gbfs-catalog.lock.json"),
    JSON.stringify({ $schema: "legacy", ...gbfs }),
  );
}
function identity(): CatalogPinCommitIdentity {
  return {
    commitId: randomUUID(),
    execution: lease.owner,
    proposalId: randomUUID(),
    validationId: randomUUID(),
    diffDigest: "e".repeat(64),
  };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-catalog-pair-"));
  docker = join(root, "infra/docker");
  mkdirSync(join(docker, "data"), { recursive: true, mode: 0o700 });
  await provisionControlInstallation(docker);
  installation = openControlInstallation({
    infraDir: docker,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const operation = { kind: "service.build" as const, serviceId: "motis" },
    hash = opsOperationFingerprint(operation),
    admittedAt = Date.now(),
    deadlineAt = admittedAt + 60000;
  const authority = retainAdmittedControlExecution(installation, {
    execution: {
      executor: "ops-agent",
      principal: "api",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      operationFingerprint: hash,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint: hash,
        deadlineAt,
      }),
    },
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["motis"],
  });
  lease = await acquireArtifactTargetLease({
    dataRoot: join(docker, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
  vi.mocked(fs.readSync).mockImplementation(nativeFs.readSync);
  closeArtifactTargetLeaseHandle(lease);
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
it("imports both exact legacy pins once, ignoring later compatibility-file changes", async () => {
  legacy();
  expect(readCatalogPinSet(root)).toBeNull();
  const first = await initializeCatalogPinSet({ rootDir: root, lease });
  expect(first).toEqual(createCatalogPinSet(transitous, gbfs));
  const ptr = readFileSync(join(docker, "catalog-pins/current.json"));
  writeFileSync(join(docker, "gbfs-catalog.lock.json"), "corrupt");
  expect(await initializeCatalogPinSet({ rootDir: root, lease })).toEqual(first);
  expect(readCatalogPinSet(root)).toEqual(first);
  expect(readFileSync(join(docker, "catalog-pins/current.json"))).toEqual(ptr);
});
it("does not initialize from missing or malformed halves", async () => {
  expect(await initializeCatalogPinSet({ rootDir: root, lease })).toBeNull();
  legacy();
  fs.unlinkSync(join(docker, "gbfs-catalog.lock.json"));
  await expect(initializeCatalogPinSet({ rootDir: root, lease })).rejects.toThrow(/Both/);
  for (const patch of [
    { sha256: "bad" },
    { commit: "abcd" },
    { url: "https://example.test/mutable" },
    { lockedAt: "yesterday" },
  ]) {
    writeFileSync(join(docker, "gbfs-catalog.lock.json"), JSON.stringify({ ...gbfs, ...patch }));
    await expect(initializeCatalogPinSet({ rootDir: root, lease })).rejects.toThrow();
  }
  expect(existsSync(join(docker, "catalog-pins/current.json"))).toBe(false);
});
it("refuses symlinked locks and replacements between descriptor checks", async () => {
  legacy();
  renameSync(join(docker, "transitous.lock.json"), join(docker, "saved.json"));
  symlinkSync("saved.json", join(docker, "transitous.lock.json"));
  await expect(initializeCatalogPinSet({ rootDir: root, lease })).rejects.toThrow();
  fs.unlinkSync(join(docker, "transitous.lock.json"));
  renameSync(join(docker, "saved.json"), join(docker, "transitous.lock.json"));
  const read = vi.mocked(fs.readSync).getMockImplementation()!;
  let seen = 0;
  const target = fs.statSync(join(docker, "transitous.lock.json"));
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
    const result = Reflect.apply(read, fs, args);
    if (fs.fstatSync(args[0]).ino === target.ino && seen++ === 0) {
      const path = join(docker, "transitous.lock.json");
      renameSync(path, `${path}.old`);
      writeFileSync(path, JSON.stringify(transitous));
    }
    return result;
  }) as typeof read);
  await expect(initializeCatalogPinSet({ rootDir: root, lease })).rejects.toThrow(/changed/);
  expect(existsSync(join(docker, "catalog-pins/current.json"))).toBe(false);
});
it("uses an attempt-bound CAS and retains its receipt after a later pointer change", async () => {
  legacy();
  const old = await initializeCatalogPinSet({ rootDir: root, lease });
  if (!old) throw Error("missing fixture pair");
  const next = createCatalogPinSet({ ...transitous, ref: `main@${"f".repeat(40)}` }, gbfs),
    commit = identity();
  const receipt = await publishCatalogPinSet({
    rootDir: root,
    lease,
    pins: next,
    expectedGenerationId: old.generationId,
    commit,
  });
  expect(receipt.phase).toBe("committed");
  expect(readCatalogPinSet(root)).toEqual(next);
  expect(await readCatalogPinCommit({ rootDir: root, commit })).toEqual(receipt);
  expect(
    await publishCatalogPinSet({
      rootDir: root,
      lease,
      pins: next,
      expectedGenerationId: old.generationId,
      commit,
    }),
  ).toEqual(receipt);
  await expect(
    publishCatalogPinSet({
      rootDir: root,
      lease,
      pins: old,
      expectedGenerationId: next.generationId,
      commit,
    }),
  ).rejects.toThrow(/intent conflict/);
  const pointerPath = join(docker, "catalog-pins/current.json"),
    pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  writeFileSync(pointerPath, JSON.stringify({ ...pointer, commitId: randomUUID() }), {
    mode: 0o600,
  });
  expect(await readCatalogPinCommit({ rootDir: root, commit })).toEqual(receipt);
});
it("recovers rename-before-receipt loss from the exact marker without rewriting the pointer", async () => {
  legacy();
  const old = await initializeCatalogPinSet({ rootDir: root, lease });
  if (!old) throw Error("missing fixture pair");
  const next = createCatalogPinSet({ ...transitous, comment: "reviewed" }, gbfs),
    commit = identity();
  const rename = nativeFs.renameSync;
  let committed = false;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith("/current.json")) {
      rename(from, to);
      committed = true;
      return;
    }
    if (
      committed &&
      fs.statSync(dirname(String(to))).ino ===
        fs.statSync(join(docker, "control-private/ops-agent/catalog-commits")).ino
    )
      throw Error("receipt rename lost");
    rename(from, to);
  });
  await expect(
    publishCatalogPinSet({
      rootDir: root,
      lease,
      pins: next,
      expectedGenerationId: old.generationId,
      commit,
    }),
  ).rejects.toThrow(/lost/);
  vi.restoreAllMocks();
  vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
  const pointerBytes = readFileSync(join(docker, "catalog-pins/current.json")),
    receipt = await readCatalogPinCommit({ rootDir: root, commit });
  expect(receipt?.phase).toBe("committed");
  expect(
    await publishCatalogPinSet({
      rootDir: root,
      lease,
      pins: next,
      expectedGenerationId: old.generationId,
      commit,
    }),
  ).toEqual(receipt);
  expect(readFileSync(join(docker, "catalog-pins/current.json"))).toEqual(pointerBytes);
});
it("never falls back to legacy files when a selected generation is corrupt", async () => {
  legacy();
  const pins = await initializeCatalogPinSet({ rootDir: root, lease });
  if (!pins) throw Error("missing fixture pair");
  writeFileSync(join(docker, `catalog-pins/generations/${pins.generationId}.json`), "{}");
  expect(() => readCatalogPinSet(root)).toThrow();
});
it("bootstraps an actual local initialization root and releases its MOTIS ownership", async () => {
  const other = mkdtempSync(join(tmpdir(), "omx-catalog-startup-")),
    infra = join(other, "infra/docker");
  mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
  await provisionControlInstallation(infra);
  const local = openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  try {
    writeFileSync(join(infra, "transitous.lock.json"), JSON.stringify(transitous));
    writeFileSync(join(infra, "gbfs-catalog.lock.json"), JSON.stringify(gbfs));
    const { initializeManagedCatalogPins } = await import("./bootstrap");
    const pins = await initializeManagedCatalogPins({ rootDir: other, installation: local });
    expect(pins).toEqual(createCatalogPinSet(transitous, gbfs));
    expect(existsSync(join(infra, "data/.admin-target-control/locks/motis"))).toBe(false);
    expect(await initializeManagedCatalogPins({ rootDir: other, installation: local })).toEqual(
      pins,
    );
  } finally {
    closeControlInstallation(local);
    rmSync(other, { recursive: true, force: true });
  }
});
it("refuses a byte-identical receipt copied to a foreign inode", async () => {
  legacy();
  const old = await initializeCatalogPinSet({ rootDir: root, lease });
  if (!old) throw Error("missing fixture pair");
  const pair = createCatalogPinSet({ ...transitous, comment: "copy check" }, gbfs),
    commit = identity();
  await publishCatalogPinSet({
    rootDir: root,
    lease,
    pins: pair,
    expectedGenerationId: old.generationId,
    commit,
  });
  const path = join(
      docker,
      `control-private/ops-agent/catalog-commits/${commit.execution.operationKey}.json`,
    ),
    bytes = readFileSync(path);
  renameSync(path, `${path}.saved`);
  writeFileSync(path, bytes, { mode: 0o600 });
  await expect(readCatalogPinCommit({ rootDir: root, commit })).rejects.toThrow(
    /identity|inode|retained/i,
  );
});
it("retains a conclusive noncommit when the live pointer rename fails before publication", async () => {
  legacy();
  const old = await initializeCatalogPinSet({ rootDir: root, lease });
  if (!old) throw Error("missing fixture pair");
  const pair = createCatalogPinSet({ ...transitous, comment: "rename refused" }, gbfs),
    commit = identity();
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(to).endsWith("/current.json")) throw Error("pointer rename refused");
    nativeFs.renameSync(from, to);
  });
  await expect(
    publishCatalogPinSet({
      rootDir: root,
      lease,
      pins: pair,
      expectedGenerationId: old.generationId,
      commit,
    }),
  ).rejects.toThrow(/refused/);
  vi.mocked(fs.renameSync).mockImplementation(nativeFs.renameSync);
  expect((await readCatalogPinCommit({ rootDir: root, commit }))?.phase).toBe("not_committed");
  expect(readCatalogPinSet(root)).toEqual(old);
  expect(existsSync(join(docker, "catalog-pins/pending.json"))).toBe(false);
});
it("does not acquire a startup target root for a malformed legacy pair", async () => {
  const other = mkdtempSync(join(tmpdir(), "omx-catalog-invalid-")),
    infra = join(other, "infra/docker");
  mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
  await provisionControlInstallation(infra);
  const local = openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  try {
    writeFileSync(join(infra, "transitous.lock.json"), JSON.stringify(transitous));
    writeFileSync(join(infra, "gbfs-catalog.lock.json"), "invalid");
    const { initializeManagedCatalogPins } = await import("./bootstrap");
    await expect(
      initializeManagedCatalogPins({ rootDir: other, installation: local }),
    ).rejects.toThrow();
    expect(existsSync(join(infra, "data/.admin-target-control/locks/motis"))).toBe(false);
  } finally {
    closeControlInstallation(local);
    rmSync(other, { recursive: true, force: true });
  }
});
it("refuses to initialize another checkout with this checkout's MOTIS lease", async () => {
  const other = mkdtempSync(join(tmpdir(), "omx-catalog-foreign-"));
  try {
    const dir = join(other, "infra/docker");
    mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "transitous.lock.json"), JSON.stringify(transitous));
    writeFileSync(join(dir, "gbfs-catalog.lock.json"), JSON.stringify(gbfs));
    await expect(initializeCatalogPinSet({ rootDir: other, lease })).rejects.toThrow(
      /root|foreign|checkout/i,
    );
    expect(existsSync(join(dir, "catalog-pins/current.json"))).toBe(false);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
