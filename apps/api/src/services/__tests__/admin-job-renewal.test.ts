import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { executeAdminJobOperation } from "../admin-job-ops";
import { prepareApiJobChildAttempt } from "../admin-job-parent";
import type { JobContext } from "../job-runner";

function context(): JobContext {
  return {
    jobId: randomUUID(),
    execution: { owner: randomUUID(), version: 1 },
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    setProgress: vi.fn(),
    checkpoint: vi.fn(),
    checkpointResult: { existing: "preserve" },
  };
}
it("keeps API parent preparation pure until the allocation CAS wins", () => {
  const ctx = context(),
    before = structuredClone(ctx.checkpointResult);
  expect(
    prepareApiJobChildAttempt(
      ctx,
      { kind: "backup.delete", backupId: "old" },
      "opk1_abcdefghijklmnop",
    ),
  ).toBeDefined();
  expect(ctx.checkpointResult).toEqual(before);
});
it("checkpoints a stable address and final timed root together before signing or POST", async () => {
  const ctx = context(),
    execute = vi.fn();
  let candidate: Record<string, unknown> | undefined;
  let address: string | undefined;
  ctx.checkpoint = vi.fn(async (value, _progress, _key, stepAddress) => {
    candidate = value;
    address = stepAddress;
    throw Error("uncertain CAS");
  });
  await expect(
    executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: "old" }, "test.renewal", {
      client: { execute } as never,
      operationKey: "opk1_stableaddress12345",
    }),
  ).rejects.toThrow();
  expect(address).toBe("opk1_stableaddress12345");
  expect(candidate).toMatchObject({
    opsProjection: {
      version: 3,
      steps: {
        opk1_stableaddress12345: {
          operationKey: expect.stringMatching(/^opk1_t1_/),
          requestedDeadlineAt: expect.any(Number),
        },
      },
    },
  });
  expect(execute).not.toHaveBeenCalled();
});

it("keeps a fixed pre-admission prerequisite separate from an agent terminal receipt", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { OpsClientError } = await import("@openmapx/core/ops"),
    { readProjection } = await import("../admin-job-ops");
  const root = await mkdtemp(join(tmpdir(), "omx-refusal-")),
    token = join(root, "api-token"),
    old = process.env.OPS_AGENT_TOKEN_FILE;
  await writeFile(token, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
  process.env.OPS_AGENT_TOKEN_FILE = token;
  const ctx = context();
  ctx.checkpoint = async (value) => {
    ctx.checkpointResult = structuredClone(value);
  };
  const execute = vi.fn().mockRejectedValue(new OpsClientError("control_upgrade_required")),
    lookup = vi.fn();
  try {
    await expect(
      executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: "daily" }, "test", {
        client: { execute, lookup } as never,
      }),
    ).rejects.toMatchObject({ errorClass: "control_upgrade_required" });
    const entries = Object.values(readProjection(ctx.checkpointResult).operations);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      phase: "refused",
      terminal: true,
      errorClass: "control_upgrade_required",
    });
    expect(entries[0]?.receiptDelivery).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    if (old === undefined) delete process.env.OPS_AGENT_TOKEN_FILE;
    else process.env.OPS_AGENT_TOKEN_FILE = old;
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses an unowned direct mutation before it can send an opaque root", async () => {
  const { executeAndWait } = await import("../ops-client"),
    execute = vi.fn();
  await expect(
    executeAndWait(
      { execute } as never,
      { kind: "backup.delete", backupId: "daily" },
      "opk1_opaqueDirect12345",
    ),
  ).rejects.toMatchObject({ errorClass: "control_upgrade_required" });
  expect(execute).not.toHaveBeenCalled();
});
