import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresDataExecutionStore,
  DATA_ADMISSION_LOCK,
  dataControlAdmission,
} from "./store.js";

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("durable execution PostgreSQL admission and CAS", () => {
  let sql: ReturnType<typeof postgres>;
  let journal: control.DataExecutionControlJournal;
  let journalRoot: string;
  const ids: string[] = [];
  /** A data-manager installation over its own directory, with its journal on `sql`. */
  async function dataManagerJournal(root: string) {
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
    });
    return { installation, journal: control.createDataExecutionControlJournal(installation, sql) };
  }
  beforeAll(async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Explicit owned synthetic database required");
    sql = postgres(url, { max: 4, connection: { statement_timeout: 5000 } });
    journalRoot = mkdtempSync(join(tmpdir(), "omx-data-store-"));
    ({ journal } = await dataManagerJournal(journalRoot));
  });
  // An unfinished execution keeps the next exclusive one out, so each test removes its rows.
  afterEach(async () => {
    if (ids.length) await sql`DELETE FROM data_manager.jobs WHERE id=ANY(${ids.splice(0)}::uuid[])`;
  });
  afterAll(async () => {
    await sql?.end();
    if (journalRoot) rmSync(journalRoot, { recursive: true, force: true });
  });
  it("retains one normalized admission under concurrent connections and rejects a renewed deadline", async () => {
    const one = createPostgresDataExecutionStore(sql, { controlJournal: journal }),
      two = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    const requestedDeadlineAt = Date.now() + 60000;
    const operationKey = createControlRootOperationKey({
      notAfter: requestedDeadlineAt,
      nonce: randomBytes(16),
    });
    const input = { kind: "download-fonts" as const };
    const first = await one.admit(input, { operationKey, requestedDeadlineAt });
    ids.push(first.record.status.id);
    const results = await Promise.all([
      one.admit(input, { operationKey, requestedDeadlineAt }),
      two.admit(input, { operationKey, requestedDeadlineAt }),
    ]);
    expect(results.map((result) => result.record.status.id)).toEqual([
      first.record.status.id,
      first.record.status.id,
    ]);
    expect(results.every((result) => !result.created)).toBe(true);
    await expect(
      two.admit(input, { operationKey, requestedDeadlineAt: requestedDeadlineAt + 1000 }),
    ).rejects.toThrow(/conflict/i);
    await expect(
      two.admit({ kind: "notable-places-build" }, { operationKey, requestedDeadlineAt }),
    ).rejects.toThrow(/conflict/i);
  });
  it("allows one owner-version writer and retains cancel intent before finalization", async () => {
    const store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    const requestedDeadlineAt = Date.now() + 60000;
    const operationKey = createControlRootOperationKey({
      notAfter: requestedDeadlineAt,
      nonce: randomBytes(16),
    });
    const admitted = await store.admit(
      { kind: "download-fonts" },
      { operationKey, requestedDeadlineAt },
    );
    const id = admitted.record.status.id;
    ids.push(id);
    const results = await Promise.all([
      store.checkpoint(id, 0, { status: "running", progress: 0.1 }),
      store.checkpoint(id, 0, { status: "running", progress: 0.2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const canceled = await store.requestCancel({
      id,
      operationKey,
      fingerprint: admitted.record.status.fingerprint,
    });
    expect(canceled?.status.status).toBe("cancel_pending");
    expect(canceled?.status.cancellationRequestedAt).not.toBeNull();
    expect(
      await store.checkpoint(id, 1, {
        status: "ok",
        publication: "committed",
        result: { kind: "download-fonts", completed: true },
      }),
    ).toBeNull();
    const rows = await sql`SELECT finished_at FROM data_manager.jobs WHERE id=${id}`;
    expect(rows[0]?.finished_at).toBeNull();
  });
  it("refuses an admission on another connection while the configuration transaction owns the nonblocking guard", async () => {
    let acquired = () => {},
      release = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${DATA_ADMISSION_LOCK[0]},${DATA_ADMISSION_LOCK[1]})`;
      acquired();
      await released;
    });
    try {
      await ready;
      const store = createPostgresDataExecutionStore(sql, { controlJournal: journal }),
        requestedDeadlineAt = Date.now() + 60000;
      const operationKey = createControlRootOperationKey({
        notAfter: requestedDeadlineAt,
        nonce: randomBytes(16),
      });
      await expect(
        store.admit({ kind: "download-fonts" }, { operationKey, requestedDeadlineAt }),
      ).rejects.toThrow("configuration_maintenance_busy");
      expect(await store.lookup(operationKey)).toBeNull();
    } finally {
      release();
      await guard;
    }
  });
  it("keeps one record of a child on its cell: reservation, binding, grant and observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "omx-data-child-cas-"));
    const { installation: dm, journal: dmJournal } = await dataManagerJournal(root);
    const store = createPostgresDataExecutionStore(sql, { controlJournal: dmJournal }),
      requestedDeadlineAt = Date.now() + 60000;
    const operationKey = createControlRootOperationKey({
      notAfter: requestedDeadlineAt,
      nonce: randomBytes(16),
    });
    const { record } = await store.admit(
      { kind: "transit-sync", countries: ["de"] },
      { operationKey, requestedDeadlineAt },
    );
    ids.push(record.status.id);
    const child = record.reservations[0];
    if (!child) throw Error("Missing original fixed child body");
    const services = ["motis", "motis-feed-proxy", "motis-staging"];
    const agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: services,
    });
    const authority = await control.retainAdmittedControlExecution(
      dm,
      dataControlAdmission({
        execution: record.execution,
        input: record.input,
        admittedAt: record.status.admittedAt,
        requestedDeadlineAt,
        parent: undefined,
        reservations: record.reservations,
      }),
    );
    const lease = await control.acquireArtifactTargetLease({
      serviceIds: services,
      owner: authority,
    });
    try {
      const races = await Promise.all([
        store.reserveChild(record.status.id, 0, child),
        store.reserveChild(record.status.id, 0, child),
      ]);
      expect(races.filter((result) => result?.continuation)).toHaveLength(1);
      const winner = races.find((result) => result?.continuation);
      if (!winner?.continuation) throw Error("Missing confirmed reserved continuation");
      expect(
        (await store.reserveChild(record.status.id, winner.record.version, child))?.continuation,
      ).toBeNull();
      await expect(
        store.checkpointChild(record.status.id, winner.record.version, {
          ...child,
          operationFingerprint: "b".repeat(64),
        }),
      ).rejects.toThrow(/child|identity/i);
      // Only the contained worker's finalization ends an execution.
      await expect(
        store.checkpoint(record.status.id, winner.record.version, {
          status: "ok",
          publication: "committed",
        }),
      ).rejects.toThrow(/terminal commitment required/);
      // The kernel's binding is the child's binding: nothing else records it.
      const exact = await control.bindControlChildPhase(authority, child);
      const binding = await control.lookupControlChildPhaseBinding(authority, child);
      if (!binding) throw Error("Missing original binding");
      const bound = {
        ...child,
        state: "bound" as const,
        execution: exact.execution,
        requestedDeadlineAt: binding.requestedDeadlineAt,
        bindingDigest: binding.bindingDigest,
        candidateDigest: null,
      };
      const afterBind = await store.inspect(record.status.id);
      expect(afterBind?.children).toEqual([bound]);
      expect(afterBind?.version).toBe(winner.record.version);
      const grantless = {
        ...bound,
        state: "attempted" as const,
        childKey: "00000000-0000-4000-8000-000000000000",
        leaseId: lease.leaseId,
        publication: "unknown" as const,
      };
      await expect(
        store.checkpointChild(record.status.id, winner.record.version, grantless),
      ).rejects.toThrow("Child differs from its original body, binding or grant");

      const issued = await control.issueControlChildPhase(authority, {
        phase: child.phase,
        ordinal: child.ordinal,
        lease,
      });
      const reference = await control.lookupControlChildPhaseAttempt(authority, child);
      if (!reference?.leaseId) throw Error("Missing original grant reference");
      const attempted = {
        ...bound,
        state: "attempted" as const,
        childKey: reference.childKey,
        leaseId: reference.leaseId,
        publication: "unknown" as const,
      };
      expect((await store.inspect(record.status.id))?.children).toEqual([attempted]);
      await control.consumeControlChildDispatch(issued.dispatchTicket);
      await expect(control.consumeControlChildDispatch(issued.dispatchTicket)).rejects.toThrow();

      // Data-manager's own part (how it observed the child) goes on the same cell.
      const observing = {
        ...attempted,
        state: "observing" as const,
        acceptedId: child.proposedId,
      };
      const moved = await store.checkpoint(record.status.id, winner.record.version, {
        progress: 0.25,
      });
      if (!moved) throw Error("Lost intervening CAS");
      expect(
        await store.checkpointChild(record.status.id, winner.record.version, observing),
      ).toBeNull();
      const observed = await store.checkpointChild(record.status.id, moved.version, observing);
      expect(observed?.children).toEqual([observing]);
      await expect(
        store.checkpointChild(record.status.id, observed?.version ?? 0, attempted),
      ).rejects.toThrow("Retained child identity/state conflict");
      const [row] = await sql<Record<string, unknown>[]>`
          SELECT * FROM data_manager.jobs WHERE id=${record.status.id}`;
      expect(row).not.toHaveProperty("execution_children");
      const cell = control.executionProgressSchema.parse(row?.execution_progress).children[0];
      expect(cell?.owner).toEqual({
        cancellationRequestedAt: null,
        observed: { state: "observing", publication: "unknown" },
      });
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
    } finally {
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
