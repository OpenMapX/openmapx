import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops/control-root-key";
import {
  type ExecutionRef,
  executionFingerprint,
  normalizeExecutionAdmission,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { inspectControlChildPublication } from "./execution-record";
import * as control from "./index";
import { installationState } from "./private-records";

afterEach(() => vi.restoreAllMocks());
/** The leases the agent's store holds for the installation at `root`. */
function heldLeases(root: string) {
  return control
    .openLeaseStore({ directory: control.leaseStoreDirectory(root), purpose: "test" })
    .list();
}
it("admits a120s fixed phase after hours of original-root work without a new root", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-late-phase-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlDirectories(root);
  const dm = control.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["motis"],
  });
  const agent = control.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 24 * 3600000;
  const operation = { kind: "transit-sync", countries: ["de"] },
    operationFingerprint = createHash("sha256").update(canonicalJson(operation)).digest("hex");
  const owner: ExecutionRef = {
    executor: "data-manager",
    principal: "data-manager",
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const body = { kind: "motis.primary.stop" as const };
  const child: ExecutionRef = {
    executor: "ops-agent",
    principal: "data-manager",
    executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    operationKey: control.controlChildOperationKey(owner.operationKey, "stop-primary", 0),
    operationFingerprint: opsOperationFingerprint(body),
    deadlineAt: admittedAt + 120000,
    fingerprint: executionFingerprint({
      kind: body.kind,
      operationFingerprint: opsOperationFingerprint(body),
      deadlineAt: admittedAt + 120000,
      parent: control.retainedControlParent(owner),
    }),
  };
  const reservation: control.ControlChildReservation = {
    version: 1,
    phase: "stop-primary",
    ordinal: 0,
    kind: body.kind,
    recipient: "ops-agent",
    serviceIds: ["motis"],
    operationFingerprint: child.operationFingerprint,
    execution: {
      executor: child.executor,
      principal: child.principal,
      executionId: child.executionId,
      operationKey: child.operationKey,
    },
  };
  const authority = await control.retainAdmittedControlExecution(dm, {
    execution: owner,
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["motis"],
    reservations: [reservation],
  });
  const lease = await control.acquireArtifactTargetLease({
    serviceIds: ["motis"],
    owner: authority,
  });
  try {
    const admission = () =>
      JSON.parse(
        readFileSync(
          join(root, "state/data-manager/control/executions", `${owner.operationKey}.json`),
          "utf8",
        ),
      ).admission;
    const original = admission();
    const held = heldLeases(root);
    const late = admittedAt + 4 * 3600000;
    vi.spyOn(Date, "now").mockReturnValue(late);
    const normalized = normalizeExecutionAdmission({
      kind: body.kind,
      operationKey: child.operationKey,
      operationFingerprint: child.operationFingerprint,
      admittedAt: late,
      requestedDeadlineAt: deadlineAt,
      parent: await control.verifiedRetainedControlParent(dm, owner),
    });
    const bound = await control.bindControlChildPhase(authority, {
      phase: "stop-primary",
      ordinal: 0,
    });
    expect(bound.execution).toEqual({
      ...child,
      deadlineAt: normalized.deadlineAt,
      fingerprint: normalized.fingerprint,
    });
    const issued = await control.issueControlChildPhase(authority, {
      phase: "stop-primary",
      ordinal: 0,
      lease,
    });
    expect(issued.channel).toBe("delegation");
    await control.consumeControlChildDispatch(issued.dispatchTicket);
    await expect(control.consumeControlChildDispatch(issued.dispatchTicket)).rejects.toThrow(
      /consumed/,
    );
    // The admission is never rewritten; only the row's progress records the child.
    expect(admission()).toEqual(original);
    expect(heldLeases(root).map((value) => value.leaseId)).toEqual(
      held.map((value) => value.leaseId),
    );
    expect(await control.cancelControlExecution(authority)).toEqual([bound.execution]);
    await expect(
      control.issueControlChildPhase(authority, {
        phase: "stop-primary",
        ordinal: 0,
        lease,
      }),
    ).rejects.toThrow();
  } finally {
    control.closeArtifactTargetLeaseHandle(lease);
    control.closeControlInstallation(agent);
    control.closeControlInstallation(dm);
    rmSync(root, { recursive: true, force: true });
  }
});

/** The first child reservation of an admission input, failing the test when it has none. */
function firstReservation(input: { reservations?: readonly control.ControlChildReservation[] }) {
  const [reservation] = input.reservations ?? [];
  assert.isDefined(reservation);
  return reservation;
}

async function fixture(exact = false, services = ["motis", "motis-staging"]) {
  const root = mkdtempSync(join(tmpdir(), "omx-phase-state-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlDirectories(root);
  const dm = control.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: services,
  });
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 24 * 3600000,
    operation = { kind: "transit-sync", countries: ["de"] };
  const operationFingerprint = createHash("sha256").update(canonicalJson(operation)).digest("hex");
  const execution: ExecutionRef = {
    executor: "data-manager",
    principal: "data-manager",
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const reservations: control.ControlChildReservation[] = ["stop-primary", "stop-staging"].map(
    (_phase, index) => ({
      version: 1,
      phase: index === 0 ? "stop-primary" : "stop-staging",
      ordinal: index,
      kind: index === 0 ? "motis.primary.stop" : "motis.staging.stop",
      recipient: "ops-agent",
      serviceIds: [services[index] ?? "motis"],
      operationFingerprint: opsOperationFingerprint(
        index === 0 ? { kind: "motis.primary.stop" } : { kind: "motis.staging.stop" },
      ),
      execution: {
        executor: "ops-agent",
        principal: "data-manager",
        executionId: `job1_${randomUUID().replaceAll("-", "")}`,
        operationKey: control.controlChildOperationKey(
          execution.operationKey,
          index === 0 ? "stop-primary" : "stop-staging",
          index,
        ),
      },
    }),
  );
  const plan = exact
    ? reservations.map(({ version: _v, operationFingerprint: body, ...slot }) => ({
        ...slot,
        execution: {
          ...slot.execution,
          operationFingerprint: body,
          deadlineAt: admittedAt + 120000,
          fingerprint: executionFingerprint({
            kind: slot.kind,
            operationFingerprint: body,
            deadlineAt: admittedAt + 120000,
            parent: control.retainedControlParent(execution),
          }),
        },
      }))
    : [];
  const input = {
    execution,
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: services,
    plan,
    ...(exact ? {} : { reservations }),
  };
  const authority = await control.retainAdmittedControlExecution(dm, input);
  const cell = join(
    root,
    "state/data-manager/control/executions",
    `${execution.operationKey}.json`,
  );
  return {
    root,
    dm,
    execution,
    input,
    authority,
    cell,
    close: () => {
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it("returns the original binding after cancel/expiry and cannot bind another phase", async () => {
  const f = await fixture();
  try {
    const phase = { phase: "stop-primary" as const, ordinal: 0 };
    const first = await control.bindControlChildPhase(f.authority, phase);
    await control.cancelControlExecution(f.authority);
    vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
    expect(await control.bindControlChildPhase(f.authority, phase)).toEqual(first);
    await expect(
      control.bindControlChildPhase(f.authority, { phase: "stop-staging", ordinal: 1 }),
    ).rejects.toThrow(/fenced|clock|expir|elapsed/i);
    expect(await control.lookupControlChildPhase(f.authority, phase)).toEqual(first);
  } finally {
    f.close();
  }
});
it("observes one same-slot binding under concurrent binds", async () => {
  const f = await fixture();
  try {
    const phase = { phase: "stop-primary" as const, ordinal: 0 };
    const results = await Promise.all([
      control.bindControlChildPhase(f.authority, phase),
      control.bindControlChildPhase(f.authority, phase),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await control.lookupControlChildPhase(f.authority, phase)).toEqual(results[0]);
  } finally {
    f.close();
  }
});
it("records a child's evidence on its cell before the binding, and its grant carries it", async () => {
  const f = await fixture(),
    agent = control.openControlInstallation({
      infraDir: f.root,
      role: "ops-agent",
      serviceIds: ["motis", "motis-staging"],
    }),
    lease = await control.acquireArtifactTargetLease({
      serviceIds: ["motis", "motis-staging"],
      owner: f.authority,
    });
  try {
    const first = { phase: "stop-primary" as const, ordinal: 0 },
      second = { phase: "stop-staging" as const, ordinal: 1 },
      evidence = { candidate: { id: "a" } };
    await control.retainControlChildEvidence(f.authority, first, evidence);
    await control.retainControlChildEvidence(f.authority, first, structuredClone(evidence));
    await expect(
      control.retainControlChildEvidence(f.authority, first, { candidate: { id: "b" } }),
    ).rejects.toThrow("Original child evidence changed");
    expect((await inspectControlChildPublication(f.authority, first)).evidence).toEqual(evidence);
    expect(JSON.parse(readFileSync(f.cell, "utf8")).progress.children[0].evidence).toEqual(
      evidence,
    );

    await control.bindControlChildPhase(f.authority, first);
    const issued = await control.issueControlChildPhase(f.authority, { ...first, lease });
    const grant = heldLeases(f.root)
      .flatMap((held) => held.children)
      .find((child) => child.key === issued.delegation.childKey);
    expect(grant?.evidence).toEqual(evidence);

    // Evidence is recorded before the binding, never added to a bound child.
    await control.bindControlChildPhase(f.authority, second);
    await expect(control.retainControlChildEvidence(f.authority, second, evidence)).rejects.toThrow(
      "A bound child's evidence cannot be added",
    );
  } finally {
    control.closeControlInstallation(agent);
    f.close();
  }
});
it("keeps an exact admission's row when a duplicate supplies empty reservations", async () => {
  const f = await fixture(true);
  try {
    const path = f.cell,
      original = readFileSync(path);
    const repeated = await control.retainAdmittedControlExecution(f.dm, {
      ...f.input,
      reservations: [],
    });
    expect(repeated.execution).toEqual(f.execution);
    expect(readFileSync(path)).toEqual(original);
  } finally {
    f.close();
  }
});

import { AnchoredDirectory } from "./filesystem";

it.each(["reference"] as const)(
  "retains the exact phase and refuses another dispatch after a crash at %s",
  async (point) => {
    const f = await fixture(),
      agent = control.openControlInstallation({
        infraDir: f.root,
        role: "ops-agent",
        serviceIds: ["motis", "motis-staging"],
      }),
      lease = await control.acquireArtifactTargetLease({
        serviceIds: ["motis", "motis-staging"],
        owner: f.authority,
      });
    let fired = false;
    try {
      const phase = { phase: "stop-primary" as const, ordinal: 0 },
        bound = await control.bindControlChildPhase(f.authority, phase),
        original = AnchoredDirectory.prototype.write;
      const fault = vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
        this: AnchoredDirectory,
        ...args: Parameters<AnchoredDirectory["write"]>
      ) {
        const [name, bytes] = args,
          text = String(bytes),
          path = this.path;
        const selected =
          !fired &&
          point === "reference" &&
          path.endsWith("/executions") &&
          name.startsWith(f.execution.operationKey) &&
          text.includes('"delegation":{');
        const value = Reflect.apply(original, this, args);
        if (selected) {
          fired = true;
          throw Error(`Synthetic crash after ${point}`);
        }
        return value;
      });
      await expect(
        control.issueControlChildPhase(f.authority, {
          ...phase,
          lease,
        }),
      ).rejects.toThrow();
      fault.mockRestore();
      expect(fired).toBe(true);
      // An ambiguous indexed write is recovery-required; a fully indexed reference
      // is readable but never issues another nominal ticket or mutation.
      try {
        expect((await control.lookupControlChildPhase(f.authority, phase))?.execution).toEqual(
          bound.execution,
        );
      } catch (error) {
        expect(String(error)).toMatch(/retained|record|changed|identity/i);
      }
      await expect(
        control.issueControlChildPhase(f.authority, {
          ...phase,
          lease,
        }),
      ).rejects.toThrow();
      try {
        expect(await control.cancelControlExecution(f.authority)).toContainEqual(bound.execution);
      } catch {
        /* Torn private/shared publication is itself a closed recovery fence. */
      }
      await expect(control.assertControlExecutionForward(f.authority)).rejects.toThrow();
      expect(heldLeases(f.root).map((value) => value.leaseId)).toEqual([lease.leaseId]);
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      f.close();
    }
  },
);

it.each(["body", "phase", "ordinal", "target", "recipient"] as const)(
  "rejects changed reserved %s before any binding or grant",
  async (field) => {
    const f = await fixture();
    try {
      const reservations = structuredClone(f.input.reservations ?? []),
        slot = reservations[0];
      if (!slot) throw Error("Fixture reservation missing");
      if (field === "body") slot.operationFingerprint = "f".repeat(64);
      if (field === "phase") slot.phase = "recover-primary";
      if (field === "ordinal") slot.ordinal = 1;
      if (field === "target") slot.serviceIds = ["motis-staging"];
      if (field === "recipient") slot.recipient = "data-manager";
      const original = readFileSync(f.cell);
      await expect(
        control.retainAdmittedControlExecution(f.dm, { ...f.input, reservations }),
      ).rejects.toThrow();
      expect(
        await control.lookupControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
      ).toBeNull();
      expect(readFileSync(f.cell)).toEqual(original);
    } finally {
      f.close();
    }
  },
);
it.each(["changed", "missing"] as const)(
  "rejects a %s execution row rather than binding a new identity",
  async (field) => {
    const f = await fixture();
    try {
      if (field === "missing") rmSync(f.cell);
      else {
        const raw = JSON.parse(readFileSync(f.cell, "utf8"));
        raw.admission.serviceIds = ["motis"];
        writeFileSync(f.cell, JSON.stringify(raw));
      }
      await expect(
        control.bindControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  },
);
it("rechecks durable cancellation inside publication after the outside identity read", async () => {
  const f = await fixture(),
    agent = control.openControlInstallation({
      infraDir: f.root,
      role: "ops-agent",
      serviceIds: ["motis", "motis-staging"],
    }),
    lease = await control.acquireArtifactTargetLease({
      serviceIds: ["motis", "motis-staging"],
      owner: f.authority,
    });
  let fired = false;
  try {
    const phase = { phase: "stop-primary" as const, ordinal: 0 };
    await control.bindControlChildPhase(f.authority, phase);
    // Cancel right after delegation read the lease from the store.
    const leases = installationState(f.dm).leases,
      read = leases.read.bind(leases);
    vi.spyOn(leases, "read").mockImplementation(async (leaseId) => {
      const value = await read(leaseId);
      if (!fired) {
        fired = true;
        await control.cancelControlExecution(f.authority);
      }
      return value;
    });
    await expect(
      control.issueControlChildPhase(f.authority, {
        ...phase,
        lease,
      }),
    ).rejects.toThrow(/fenced|cancel/i);
    expect(fired).toBe(true);
    expect((await inspectControlChildPublication(f.authority, phase)).publication.state).toBe(
      "unissued",
    );
    expect(await control.cancelControlExecution(f.authority)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    control.closeArtifactTargetLeaseHandle(lease);
    control.closeControlInstallation(agent);
    f.close();
  }
});
it("binds one same-slot identity across actual filesystem processes", async () => {
  const f = await fixture(),
    { build } = await import("esbuild"),
    { spawn } = await import("node:child_process"),
    { createInterface } = await import("node:readline"),
    bundle = join(f.root, "phase-process.mjs");
  try {
    await build({
      entryPoints: [join(import.meta.dirname, "test-fixtures/child-phase-process.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      outfile: bundle,
    });
    const run = async () => {
      const process = spawn(globalThis.process.execPath, [bundle], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      process.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const lines = createInterface({ input: process.stdout }),
        next = lines[Symbol.asyncIterator]().next(),
        exited = new Promise<void>((resolve) => process.once("close", () => resolve()));
      process.stdin.end(`${JSON.stringify({ root: f.root, execution: f.execution })}\n`);
      const result = await next;
      await exited;
      lines.close();
      if (result.done) throw Error(`Phase process exited without evidence: ${stderr}`);
      return JSON.parse(result.value) as {
        ok: boolean;
        child?: control.ControlPlannedChild;
        error?: string;
      };
    };
    const results = await Promise.all([run(), run()]);
    expect(results.some((result) => result.ok)).toBe(true);
    const bound = await control.lookupControlChildPhase(f.authority, {
      phase: "stop-primary",
      ordinal: 0,
    });
    expect(bound).not.toBeNull();
    for (const result of results)
      if (result.ok) expect(result.child).toEqual(bound);
      else {
        // A process that finds its peer holding the row's writer guard past
        // the wait refuses. A refusal never authorizes a new identity; the
        // fresh retry below must observe the winner exactly.
        expect(result.error).toMatch(/busy|writer/);
      }
    expect(
      await control.bindControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
    ).toEqual(bound);
  } finally {
    f.close();
  }
}, 30000);
it("refuses a prospective phase plan above the combined64 slots before exposure", async () => {
  const f = await fixture();
  try {
    const reservations = Array.from({ length: 65 }, (_, ordinal) => ({
      ...firstReservation(f.input),
      ordinal,
      execution: {
        ...firstReservation(f.input).execution,
        operationKey: control.controlChildOperationKey(
          f.execution.operationKey,
          "stop-primary",
          Math.min(ordinal, 63),
        ),
      },
    }));
    await expect(
      control.retainAdmittedControlExecution(f.dm, { ...f.input, reservations }),
    ).rejects.toThrow();
    expect(
      await control.lookupControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
    ).toBeNull();
  } finally {
    f.close();
  }
});

it("refuses an execution row above its capacity before writing it", async () => {
  const services = Array.from(
      { length: 256 },
      (_, n) => `svc-${String(n).padStart(3, "0")}-${"a".repeat(50)}`,
    ),
    f = await fixture(false, services);
  try {
    const deadlineAt = f.execution.deadlineAt,
      execution = {
        ...f.execution,
        executionId: randomUUID(),
        operationKey: createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
      },
      base = firstReservation(f.input),
      reservations = Array.from({ length: 64 }, (_, ordinal) => ({
        ...base,
        ordinal,
        serviceIds: [...services].sort(),
        execution: {
          ...base.execution,
          executionId: `job1_${randomUUID().replaceAll("-", "")}`,
          operationKey: control.controlChildOperationKey(
            execution.operationKey,
            "stop-primary",
            ordinal,
          ),
        },
      }));
    await expect(
      control.retainAdmittedControlExecution(f.dm, {
        ...f.input,
        execution,
        reservations,
        serviceIds: services,
      }),
    ).rejects.toThrow(/Execution row capacity/);
    expect(
      (await import("node:fs")).existsSync(
        join(f.root, "state/data-manager/control/executions", `${execution.operationKey}.json`),
      ),
    ).toBe(false);
  } finally {
    f.close();
  }
}, 30000);

async function deadlineFixture(
  operation: import("../ops/contract").OpsOperation = { kind: "data.downloadFonts" },
) {
  const root = mkdtempSync(join(tmpdir(), "omx-fixed-phase-ancestry-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlDirectories(root);
  const services = ["data-manager"],
    agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: services,
    }),
    dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: services,
    }),
    operationFingerprint = opsOperationFingerprint(operation),
    deadlineAt = Date.now() + 60000,
    execution: ExecutionRef = {
      executor: "ops-agent",
      principal: "api",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    },
    plan = control.planFixedSingleDataCommand(execution, operation, services),
    authority = await control.retainAdmittedControlExecution(agent, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt: Date.now(),
      requestedDeadlineAt: deadlineAt,
      serviceIds: services,
      reservations: [plan.rootReservation],
    });
  control.retainFixedSingleDataPlan(authority, plan);
  const bound = await control.bindControlChildPhase(authority, plan.rootReservation),
    args = control.fixedCliArguments(operation);
  await control.retainFixedCliSpawnIntent(authority, {
    childKey: plan.delegationId,
    execution: bound.execution,
    operation,
    args,
    reservations: plan.cliReservations,
  });
  const issued = await control.issueControlChildPhase(authority, {
    ...plan.rootReservation,
    childKey: plan.delegationId,
  });
  await control.consumeControlChildDispatch(issued.dispatchTicket);
  const cli = control.openFixedChildInstallation({
      infraDir: root,
      child: { leaseId: null, childKey: issued.delegation.childKey },
    }),
    intent = control.readFixedCliSpawnIntent(cli, bound.execution, args),
    parent = await control.verifiedRetainedControlParent(cli, intent.parent),
    cliAuthority = await control.retainAdmittedControlExecution(cli, {
      execution: bound.execution,
      kind: operation.kind,
      operation,
      admittedAt: intent.admittedAt,
      requestedDeadlineAt: bound.execution.deadlineAt,
      parent,
      serviceIds: intent.serviceIds,
      reservations: intent.reservations,
    });
  await control.beginFixedCliExecution(cli, bound.execution);
  return {
    root,
    agent,
    dm,
    cli,
    authority,
    execution,
    cliAuthority,
    cliExecution: bound.execution,
    slot: firstReservation({ reservations: plan.cliReservations }),
    close() {
      control.closeControlInstallation(cli);
      control.closeControlInstallation(dm);
      control.closeControlInstallation(agent);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it.each(["cancel-first", "grant-first"] as const)(
  "keeps fixed CLI deadline-only descendant publication ordered with ancestor cancellation (%s)",
  async (order) => {
    const f = await deadlineFixture();
    let fired = false;
    try {
      const bound = await control.bindControlChildPhase(f.cliAuthority, f.slot);
      expect(heldLeases(f.root)).toEqual([]);
      if (order === "cancel-first") {
        // Cancel the ancestor when the child first reads it.
        const rows = installationState(f.cli).rows,
          read = rows.read.bind(rows);
        vi.spyOn(rows, "read").mockImplementation(async (key) => {
          if (!fired && key === f.execution.operationKey) {
            fired = true;
            await control.cancelControlExecution(f.authority);
          }
          return read(key);
        });
        await expect(
          control.issueControlChildPhase(f.cliAuthority, {
            ...f.slot,
          }),
        ).rejects.toThrow(/cancel|fenced/i);
        expect(fired).toBe(true);
        expect(
          (await inspectControlChildPublication(f.cliAuthority, f.slot)).publication.state,
        ).toBe("unissued");
        expect(await control.cancelControlExecution(f.cliAuthority)).toEqual([]);
      } else {
        const issued = await control.issueControlChildPhase(f.cliAuthority, {
          ...f.slot,
        });
        await control.cancelControlExecution(f.authority);
        expect(await control.cancelControlExecution(f.cliAuthority)).toEqual([bound.execution]);
        await expect(control.consumeControlChildDispatch(issued.dispatchTicket)).rejects.toThrow(
          /cancel|fenced/i,
        );
        expect(
          (await control.lookupControlChildPhaseAttempt(f.cliAuthority, f.slot))?.execution,
        ).toEqual(bound.execution);
      }
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
  30000,
);

it.each(["Pull", "Ingest", "Extract"] as const)(
  "binds Overture %s to one original fixed CLI/data command and rejects substitution",
  async (suffix) => {
    const operation = { kind: `data.overture${suffix}` as const, regionId: "europe/germany" };
    const f = await deadlineFixture(operation);
    try {
      expect(control.fixedCliArguments(operation)).toEqual([
        "data",
        `overture-${suffix.toLowerCase()}`,
        "europe/germany",
      ]);
      const original = await control.bindControlChildPhase(f.cliAuthority, f.slot);
      expect(original.execution.operationFingerprint).toBe(
        control.fixedDataBodyFingerprint(control.fixedDataCommandInput(operation)),
      );
      expect(() =>
        control.readFixedCliSpawnIntent(f.cli, f.cliExecution, [
          "data",
          "overture-sync",
          "europe/france",
        ]),
      ).toThrow();
      const issued = await control.issueControlChildPhase(f.cliAuthority, {
        ...f.slot,
      });
      await control.consumeControlChildDispatch(issued.dispatchTicket);
      await expect(control.consumeControlChildDispatch(issued.dispatchTicket)).rejects.toThrow();
      expect(
        (await control.lookupControlChildPhaseAttempt(f.cliAuthority, f.slot))?.execution,
      ).toEqual(original.execution);
    } finally {
      f.close();
    }
  },
  30000,
);
