import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataChildControlReservation } from "./ops-children.js";
import { createPostgresDataExecutionStore, DATA_ADMISSION_LOCK } from "./store.js";

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("durable execution PostgreSQL admission and CAS", () => {
  let sql: ReturnType<typeof postgres>;
  const ids: string[] = [];
  beforeAll(() => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Explicit owned synthetic database required");
    sql = postgres(url, { max: 4, connection: { statement_timeout: 5000 } });
  });
  afterAll(async () => {
    if (sql) {
      if (ids.length) await sql`DELETE FROM data_manager.jobs WHERE id=ANY(${ids}::uuid[])`;
      await sql.end();
    }
  });
  it("retains one normalized admission under concurrent connections and rejects a renewed deadline", async () => {
    const one = createPostgresDataExecutionStore(sql),
      two = createPostgresDataExecutionStore(sql);
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
    const store = createPostgresDataExecutionStore(sql);
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
      const store = createPostgresDataExecutionStore(sql),
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
  it.each(["claimed", "stale"] as const)(
    "uses real body/binding/grant evidence for a single child CAS continuation (%s)",
    async (mode) => {
      const store = createPostgresDataExecutionStore(sql),
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
      const root = mkdtempSync(join(tmpdir(), "omx-data-child-cas-"));
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await control.provisionControlInstallation(root);
      const services = ["motis", "motis-feed-proxy", "motis-staging"];
      const dm = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: services,
      });
      const agent = control.openControlInstallation({
        infraDir: root,
        role: "ops-agent",
        serviceIds: services,
      });
      const authority = control.retainAdmittedControlExecution(dm, {
        execution: record.execution,
        kind: record.input.kind,
        operation: record.input,
        admittedAt: record.status.admittedAt,
        requestedDeadlineAt,
        serviceIds: services,
        reservations: record.reservations.map(dataChildControlReservation),
      });
      const lease = await control.acquireArtifactTargetLease({
        dataRoot: join(root, "data"),
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
        await expect(
          store.checkpoint(record.status.id, winner.record.version, {
            status: "ok",
            publication: "committed",
          }),
        ).rejects.toThrow(/unsettled/i);
        const exact = await control.bindControlChildPhase(authority, child);
        const binding = control.lookupControlChildPhaseBinding(authority, child);
        if (!binding) throw Error("Missing original binding");
        const bound = {
          ...child,
          state: "bound" as const,
          execution: exact.execution,
          requestedDeadlineAt: binding.requestedDeadlineAt,
          bindingDigest: binding.bindingDigest,
          candidateDigest: null,
        };
        const saved = await store.checkpointChild(record.status.id, winner.record.version, bound);
        if (!saved) throw Error("Lost bound checkpoint");
        const issued = await control.issueControlChildPhase(authority, {
          phase: child.phase,
          ordinal: child.ordinal,
          lease,
          childPublicKey: agent.publicKey,
        });
        const reference = control.lookupControlChildPhaseAttempt(authority, child);
        if (!reference?.leaseId) throw Error("Missing original grant reference");
        const attempted = {
          ...bound,
          state: "attempted" as const,
          delegationId: reference.delegationId,
          grantDigest: reference.grantDigest,
          leaseId: reference.leaseId,
          dispatchState: "claimed" as const,
        };
        await expect(
          store.claimChildDispatch(record.status.id, saved.version, attempted, {
            ...winner.continuation,
          }),
        ).rejects.toThrow(/continuation/i);
        if (mode === "stale") {
          const moved = await store.checkpoint(record.status.id, saved.version, { progress: 0.25 });
          if (!moved) throw Error("Lost intervening CAS");
          expect(
            await store.claimChildDispatch(
              record.status.id,
              saved.version,
              attempted,
              winner.continuation,
            ),
          ).toBeNull();
          await expect(
            store.claimChildDispatch(
              record.status.id,
              moved.version,
              attempted,
              winner.continuation,
            ),
          ).rejects.toThrow(/continuation/i);
          expect((await store.inspect(record.status.id))?.children[0]?.state).toBe("bound");
        } else {
          const claimed = await store.claimChildDispatch(
            record.status.id,
            saved.version,
            attempted,
            winner.continuation,
          );
          expect(claimed?.children[0]).toEqual(attempted);
          control.consumeControlChildDispatch(issued.dispatchTicket);
          expect(() => control.consumeControlChildDispatch(issued.dispatchTicket)).toThrow();
          await expect(
            store.claimChildDispatch(
              record.status.id,
              claimed?.version ?? 0,
              attempted,
              winner.continuation,
            ),
          ).rejects.toThrow(/continuation/i);
        }
        await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
      } finally {
        control.closeArtifactTargetLeaseHandle(lease);
        control.closeControlInstallation(agent);
        control.closeControlInstallation(dm);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
