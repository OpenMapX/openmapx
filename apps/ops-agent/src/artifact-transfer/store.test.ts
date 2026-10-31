import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactTransferStore } from "./store";

const roots: string[] = [];
const stores: ArtifactTransferStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(free = 2 * 1024 ** 3, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "openmapx-transfer-"));
  roots.push(root);
  await mkdir(join(root, "data"), { mode: 0o700 });
  await mkdir(join(root, "private"), { mode: 0o700 });
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token: "test-api-token",
    capacity: () => ({ bytes: free, inodes: 100000 }),
    now,
  });
  stores.push(store);
  return { root, store };
}
const ownerId = "admin-one";
const input = () => ({
  ownerId,
  purpose: "prepared-artifact" as const,
  direction: "upload" as const,
  operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
});
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

it("sweeps only expired unowned stages and preserves admission replay tombstones", async () => {
  let now = Date.now();
  const { store, root } = await fixture(undefined, () => now);
  const request = { ...input(), declaredBytes: 4 };
  const stage = await store.createStage(request);
  const freshRequest = { ...input(), declaredBytes: 1 };
  now = Date.parse(stage.expiresAt) - 1000;
  const fresh = await store.createStage(freshRequest);
  expect(await store.reconcileTransferStages({ signal: new AbortController().signal })).toEqual({
    expired: 0,
    removed: 0,
    cleanupFailed: 0,
  });
  now += 1001;
  expect(await store.reconcileTransferStages({ signal: new AbortController().signal })).toEqual({
    expired: 1,
    removed: 1,
    cleanupFailed: 0,
  });
  expect(await store.createStage(request)).toMatchObject({
    stageId: stage.stageId,
    state: "expired",
    cleanup: "complete",
  });
  expect((await store.getStage({ ...freshRequest, stageId: fresh.stageId })).state).toBe("created");
  expect(await store.reservedBytes()).toBe(1);
  expect(await readFile(join(root, "private", `${stage.stageId}.json`), "utf8")).toContain(
    stage.stageId,
  );
  expect(await store.reconcileTransferStages({ signal: new AbortController().signal })).toEqual({
    expired: 0,
    removed: 0,
    cleanupFailed: 0,
  });
});

it("reclaims authenticated completed tombstones after seven days while preserving their replay window", async () => {
  let now = Date.now();
  const { store, root } = await fixture(undefined, () => now);
  const request = { ...input(), declaredBytes: 1 },
    stage = await store.createStage(request);
  await store.deleteStage({ stageId: stage.stageId, ownerId });
  now = Date.parse(stage.expiresAt) + 7 * 86400000 - 1;
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  expect((await store.createStage(request)).stageId).toBe(stage.stageId);
  now += 2;
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  await expect(readFile(join(root, "private", `${stage.stageId}.json`))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await store.createStage(request)).stageId).not.toBe(stage.stageId);
  expect(await readFile(join(root, "private/sweep-cursor.json"), "utf8")).toContain("mac");
});

it("cleans a conclusively failed upload using its retained original content inode", async () => {
  const { store } = await fixture();
  const stage = await store.createStage({ ...input(), declaredBytes: 2 });
  await expect(
    store.upload({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body: stream(new Uint8Array([1])),
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
  await store.deleteStage({ stageId: stage.stageId, ownerId });
  expect(await store.reservedBytes()).toBe(0);
});
it("shutdown waits for the original body and file cleanup before reporting the byte drain complete", async () => {
  const { store } = await fixture();
  const stage = await store.createStage({ ...input(), declaredBytes: 4 });
  let release!: () => void,
    cancelCalled = false,
    drained = false;
  const canceled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCalled = true;
      return canceled;
    },
  });
  const upload = store
    .upload({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body,
    })
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = store.drainByteStreams().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(cancelCalled).toBe(true);
  expect(drained).toBe(false);
  expect(store.activeStreams).toBe(1);
  await expect(store.createStage(input())).rejects.toMatchObject({ statusCode: 503 });
  await expect(store.deleteStage({ stageId: stage.stageId, ownerId })).rejects.toMatchObject({
    statusCode: 409,
  });
  release();
  await closing;
  expect(await upload).toBeInstanceOf(Error);
  expect(store.activeStreams).toBe(0);
  await store.deleteStage({ stageId: stage.stageId, ownerId });
  expect(await store.reservedBytes()).toBe(0);
});
it("streams exact non-UTF8 bytes, journals digest and never calls an upload ready", async () => {
  const { store } = await fixture();
  const bytes = new Uint8Array([0, 255, 192, 128]);
  const request = { ...input(), declaredBytes: 4 };
  const stage = await store.createStage(request);
  expect(await store.createStage(request)).toEqual(stage);
  const result = await store.upload({
    stageId: stage.stageId,
    ownerId,
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 10000,
    body: stream(bytes),
  });
  expect(result.state).toBe("uploaded");
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.bytes).toBe(4);
  expect(await store.getStage({ stageId: stage.stageId, ownerId, purpose: stage.purpose })).toEqual(
    result,
  );
  await expect(
    store.getStage({ stageId: stage.stageId, ownerId: "foreign", purpose: stage.purpose }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    store.openDownload(
      {
        stageId: stage.stageId,
        ownerId,
        purpose: stage.purpose,
        attemptId: randomUUID(),
        deadlineAt: Date.now() + 1000,
      },
      async () => {},
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it("refuses unknown space and reserves actual small uploads, not expansion ceiling", async () => {
  const { store } = await fixture();
  const stage = await store.createStage({ ...input(), declaredBytes: 2 * 1024 ** 2 });
  expect(stage.state).toBe("created");
  expect(await store.reservedBytes()).toBe(2 * 1024 ** 2);
  const { store: small } = await fixture(512);
  await expect(small.createStage({ ...input(), declaredBytes: 4 })).rejects.toMatchObject({
    statusCode: 507,
  });
  const { root } = await fixture();
  const unavailable = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token: "test-api-token",
    capacity: () => {
      throw Error("unknown");
    },
  });
  stores.push(unavailable);
  await expect(unavailable.createStage(input())).rejects.toMatchObject({ statusCode: 507 });
});
it("foreign requests do not pull; length/digest lies and disconnect cannot finalize", async () => {
  const { store } = await fixture();
  let pulled = 0;
  const body = () =>
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(5));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
  const stage = await store.createStage({ ...input(), declaredBytes: 4 });
  await expect(
    store.upload({
      stageId: stage.stageId,
      ownerId: "foreign",
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body: body(),
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(pulled).toBe(0);
  await expect(
    store.upload({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body: body(),
    }),
  ).rejects.toMatchObject({ statusCode: 413 });
  expect(
    (await store.getStage({ stageId: stage.stageId, ownerId, purpose: stage.purpose })).state,
  ).toBe("failed");
  const wrong = await store.createStage({
    ...input(),
    declaredBytes: 4,
    expectedSha256: "a".repeat(64),
  });
  await expect(
    store.upload({
      stageId: wrong.stageId,
      ownerId,
      purpose: wrong.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body: stream(new Uint8Array(4)),
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
});
it("protects accepted writer against simultaneous upload and delete, then awaits cancellation", async () => {
  const { store } = await fixture();
  const stage = await store.createStage({ ...input(), declaredBytes: 4 });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const abort = new AbortController();
  const first = store.upload({
    stageId: stage.stageId,
    ownerId,
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 10000,
    body,
    signal: abort.signal,
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(store.activeStreams).toBe(1);
  await expect(store.deleteStage({ stageId: stage.stageId, ownerId })).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(
    store.upload({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body: stream(new Uint8Array(4)),
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  abort.abort();
  await expect(first).rejects.toBeDefined();
  expect(store.activeStreams).toBe(0);
  expect(body.locked).toBe(false);
  expect(() => controller.close()).toThrow();
});
it("refuses replaced stage roots and unavailable purpose consumers", async () => {
  const { store, root } = await fixture();
  const stage = await store.createStage({ ...input(), declaredBytes: 4 });
  await store.upload({
    stageId: stage.stageId,
    ownerId,
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 10000,
    body: stream(new Uint8Array(4)),
  });
  await expect(
    store.claimStage({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      use: "validate-build",
      expectedSha256: stage.sha256 ?? "0".repeat(64),
      identity: {
        executionId: `job1_${"a".repeat(20)}`,
        operationKey: `opk1_${"a".repeat(20)}`,
        fingerprint: "a".repeat(64),
        executionDeadlineAt: new Date(Date.now() + 10000).toISOString(),
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const location = join(root, "data", stage.stageId);
  await rename(location, `${location}.old`);
  await symlink(`${location}.old`, location);
  await expect(
    store.getStage({ stageId: stage.stageId, ownerId, purpose: stage.purpose }),
  ).rejects.toBeDefined();
  expect(await readFile(join(`${location}.old`, "content"))).toHaveLength(4);
});
it("admits a declared 600 GiB stage using its actual reservation", async () => {
  const { store } = await fixture(2 * 1024 ** 4);
  const stage = await store.createStage({ ...input(), declaredBytes: 600 * 1024 ** 3 });
  expect(stage.bytes).toBe(0);
  expect(await store.reservedBytes()).toBe(600 * 1024 ** 3);
});
it("streams generated 2 GiB with bounded pull-ahead and no materialized body", async () => {
  const { store } = await fixture(5 * 1024 ** 3);
  const length = 2 * 1024 ** 3,
    chunk = new Uint8Array(4 * 1024 ** 2);
  let emitted = 0,
    maximumAhead = 0;
  const stage = await store.createStage({ ...input(), declaredBytes: length });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (emitted === length) {
          controller.close();
          return;
        }
        const observed = await store.getStage({
          stageId: stage.stageId,
          ownerId,
          purpose: stage.purpose,
        });
        emitted += chunk.byteLength;
        maximumAhead = Math.max(maximumAhead, emitted - observed.bytes);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 1 },
  );
  const result = await store.upload({
    stageId: stage.stageId,
    ownerId,
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 120000,
    body,
  });
  expect(result.bytes).toBe(length);
  expect(result.state).toBe("uploaded");
  expect(maximumAhead).toBeLessThanOrEqual(8 * 1024 ** 2);
  expect(store.activeStreams).toBe(0);
  await store.deleteStage({ stageId: stage.stageId, ownerId });
  expect(await store.reservedBytes()).toBe(0);
}, 120000);
it("closes new admissions during the existing drain without dropping the active stream", async () => {
  const { root } = await fixture();
  let open = true;
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token: "test-api-token",
    admissionsOpen: () => open,
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
  });
  stores.push(store);
  const stage = await store.createStage({ ...input(), declaredBytes: 1 });
  const abort = new AbortController();
  let bodyPulled!: () => void;
  const pulling = new Promise<void>((resolve) => {
    bodyPulled = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        bodyPulled();
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const pending = store
    .upload({
      stageId: stage.stageId,
      ownerId,
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 10000,
      body,
      signal: abort.signal,
    })
    .catch((error) => error);
  await Promise.race([
    pulling,
    pending.then((error) => {
      throw error;
    }),
  ]);
  open = false;
  await expect(store.createStage(input())).rejects.toMatchObject({ statusCode: 503 });
  expect(store.activeStreams).toBe(1);
  expect(
    (await store.getStage({ stageId: stage.stageId, ownerId, purpose: stage.purpose })).state,
  ).toBe("uploading");
  abort.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(store.activeStreams).toBe(0);
});
it("keeps production transfer metadata out of the strict configuration startup queue", async () => {
  const { root } = await fixture();
  const infraDir = join(root, "infra");
  const queue = join(infraDir, "data", "ops-agent", "trusted-config");
  await mkdir(queue, { recursive: true, mode: 0o700 });
  const { artifactTransferPrivateRoot } = await import("./store");
  const { initializeTerminalClaimCleanup } = await import("../trusted-config-source");
  await initializeTerminalClaimCleanup(queue, {
    allowedUids: [process.getuid!()],
    expectedGid: process.getgid!(),
    token: "t".repeat(43),
    journalRecords: [],
  });
  const store = new ArtifactTransferStore({
    dataRoot: join(infraDir, "data", ".openmapx-transfers"),
    privateRoot: artifactTransferPrivateRoot(infraDir),
    token: "t".repeat(43),
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
  });
  stores.push(store);
  await store.createStage({ ...input(), declaredBytes: 4 });
  await expect(
    initializeTerminalClaimCleanup(queue, {
      allowedUids: [process.getuid!()],
      expectedGid: process.getgid!(),
      token: "t".repeat(43),
      journalRecords: [],
    }),
  ).resolves.toBeDefined();
  expect(artifactTransferPrivateRoot(infraDir, true)).toBe(
    "/var/lib/openmapx/control-private/artifact-transfers",
  );
});
