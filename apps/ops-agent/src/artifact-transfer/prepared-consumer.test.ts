import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  opsOperationFingerprint,
  opsOperationSchema,
} from "@openmapx/core/ops";
import { afterEach, expect, it } from "vitest";

import type { OpsExecutionContext } from "../runtime";
import { ArtifactTransferStore } from "./store";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.reverse().splice(0)) close();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-prepared-consumer-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const infra = join(root, "infra");
  mkdirSync(join(infra, "data"), { recursive: true });
  await control.provisionControlInstallation(infra);
  const installation = control.openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  cleanups.push(() => control.closeControlInstallation(installation));
  let available = 4 * 1024 ** 3;
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "stages"),
    privateRoot: join(root, "private"),
    token: "fixture-prepared-consumer",
    capacity: () => ({ bytes: available, inodes: 100000 }),
  });
  cleanups.push(() => store.close());
  const payload = Buffer.from("synthetic graph"),
    manifest = {
      schemaVersion: 1,
      service: "osrm",
      builtAt: "2026-10-30T00:00:00.000Z",
      runtimeImages: { osrm: "example/osrm:1" },
      toolImages: {},
      dirs: ["osrm-graph"],
      directories: ["osrm-graph"],
      files: [
        {
          path: "osrm-graph/region.osrm",
          sizeBytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      ],
    };
  const source = join(root, "source");
  mkdirSync(join(source, "osrm-graph"), { recursive: true });
  const fs = await import("node:fs");
  fs.writeFileSync(join(source, "osrm-graph/region.osrm"), payload);
  const chunks: Buffer[] = [];
  await control.writeBuildBundle({
    dataRoot: source,
    serviceId: "osrm",
    record: {
      schemaVersion: 1,
      service: "osrm",
      builtAt: manifest.builtAt,
      runtimeImages: manifest.runtimeImages,
      toolImages: {},
    },
    target: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    limits: control.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  const bytes = Buffer.concat(chunks);
  const stage = await store.createStage({
    purpose: "prepared-artifact",
    direction: "upload",
    ownerId: "fixture-admin",
    declaredBytes: bytes.length,
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
  });
  await store.upload({
    stageId: stage.stageId,
    ownerId: "fixture-admin",
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 60000,
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  });
  function context(ownerId = "fixture-admin"): OpsExecutionContext {
    const operation = opsOperationSchema.parse({
        kind: "artifactTransfer.validate",
        stageId: stage.stageId,
        ownerId,
        purpose: "prepared-artifact",
      }),
      operationFingerprint = opsOperationFingerprint(operation),
      admittedAt = Date.now(),
      operationKey = createControlRootOperationKey({
        notAfter: admittedAt + 600000,
        nonce: randomBytes(16),
      }),
      admission = normalizeExecutionAdmission({
        operationFingerprint,
        operationKey,
        kind: operation.kind,
        admittedAt,
        requestedDeadlineAt: admittedAt + 600000,
      });
    const execution = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey,
      operationFingerprint,
      deadlineAt: admission.deadlineAt,
      fingerprint: admission.fingerprint,
    };
    const authority = control.retainAdmittedControlExecution(installation, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt,
      requestedDeadlineAt: admittedAt + 600000,
      serviceIds: ["osrm"],
    });
    return {
      execution,
      controlAuthority: authority,
      signal: new AbortController().signal,
      emitLog: () => {},
      claim: {
        source: "registry",
        operation,
        fingerprint: operationFingerprint,
        capability: { revisionId: "fixture", values: {} },
      },
    };
  }
  return {
    root,
    store,
    stage,
    context,
    setCapacity: (bytes: number) => {
      available = bytes;
    },
  };
}
it("validates prepared upload under its actual retained execution and returns the same ready stage on replay", async () => {
  const f = await fixture();
  expect(
    f.store.validatePreparedArtifact,
    "prepared artifact consumer is not installed",
  ).toBeTypeOf("function");
  const ctx = f.context();
  const result = await f.store.validatePreparedArtifact(ctx);
  expect(result).toMatchObject({
    stageId: f.stage.stageId,
    state: "ready",
    purpose: "prepared-artifact",
  });
  expect(await f.store.validatePreparedArtifact(ctx)).toEqual(result);
});
it("refuses a different owner before claiming prepared bytes", async () => {
  const f = await fixture();
  expect(f.store.validatePreparedArtifact).toBeTypeOf("function");
  await expect(f.store.validatePreparedArtifact(f.context("foreign-admin"))).rejects.toThrow();
  expect(
    (
      await f.store.getStage({
        stageId: f.stage.stageId,
        ownerId: "fixture-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("uploaded");
});
it("refuses exact manifest capacity before extracting payload and retains conservative stage accounting", async () => {
  const f = await fixture();
  expect(f.store.validatePreparedArtifact).toBeTypeOf("function");
  f.setCapacity(1024);
  await expect(f.store.validatePreparedArtifact(f.context())).rejects.toThrow(/capacity/);
  const names = readdirSync(join(f.root, "stages", f.stage.stageId)).filter((name) =>
    name.startsWith("prepared-"),
  );
  expect(names).toHaveLength(1);
  expect(readdirSync(join(f.root, "stages", f.stage.stageId, names[0]!))).toEqual([]);
  expect(await f.store.reservedBytes()).toBeGreaterThan(0);
});

it("revalidates the same immutable upload with distinct bounded extraction claims", async () => {
  const f = await fixture();
  await f.store.validatePreparedArtifact(f.context());
  const previous = await f.store.reservedBytes();
  expect((await f.store.validatePreparedArtifact(f.context())).state).toBe("ready");
  expect(await f.store.reservedBytes()).toBeGreaterThan(previous);
  expect(
    readdirSync(join(f.root, "stages", f.stage.stageId)).filter((name) =>
      name.startsWith("prepared-"),
    ),
  ).toHaveLength(2);
}, 60000);

it("rejects a changed execution identity before claiming uploaded bytes", async () => {
  const f = await fixture(),
    ctx = f.context();
  const changed = {
    ...ctx,
    execution: { ...ctx.execution, executionId: `job1_${randomUUID().replaceAll("-", "")}` },
  };
  await expect(f.store.validatePreparedArtifact(changed)).rejects.toThrow(
    /Original prepared artifact/,
  );
  expect(
    (
      await f.store.getStage({
        stageId: f.stage.stageId,
        ownerId: "fixture-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("uploaded");
}, 60000);
