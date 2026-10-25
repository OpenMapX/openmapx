import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops/control-root-key";
import {
  type ExecutionRef,
  executionFingerprint,
  normalizeExecutionAdmission,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { inspectControlChildPublication } from "./child-phase";
import * as control from "./index";

afterEach(() => vi.restoreAllMocks());
it("admits a120s fixed phase after hours of original-root work without a new root", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-late-phase-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(root);
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
  const authority = control.retainAdmittedControlExecution(dm, {
    execution: owner,
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["motis"],
    reservations: [reservation],
  });
  const lease = await control.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  try {
    const original = readFileSync(
      join(root, "control-private/data-manager/executions", `${owner.operationKey}.json`),
    );
    const held = statSync(join(root, "data/.admin-target-control/locks/motis")).ino;
    const late = admittedAt + 4 * 3600000;
    vi.spyOn(Date, "now").mockReturnValue(late);
    const normalized = normalizeExecutionAdmission({
      kind: body.kind,
      operationKey: child.operationKey,
      operationFingerprint: child.operationFingerprint,
      admittedAt: late,
      requestedDeadlineAt: deadlineAt,
      parent: control.verifiedRetainedControlParent(dm, owner),
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
      childPublicKey: agent.publicKey,
      lease,
    });
    expect(issued.channel).toBe("delegation");
    control.consumeControlChildDispatch(issued.dispatchTicket);
    expect(() => control.consumeControlChildDispatch(issued.dispatchTicket)).toThrow(/consumed/);
    expect(
      readFileSync(
        join(root, "control-private/data-manager/executions", `${owner.operationKey}.json`),
      ),
    ).toEqual(original);
    expect(statSync(join(root, "data/.admin-target-control/locks/motis")).ino).toBe(held);
    expect(control.cancelControlExecution(authority)).toEqual([bound.execution]);
    await expect(
      control.issueControlChildPhase(authority, {
        phase: "stop-primary",
        ordinal: 0,
        childPublicKey: agent.publicKey,
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

async function fixture(exact = false, services = ["motis", "motis-staging"]) {
  const root = mkdtempSync(join(tmpdir(), "omx-phase-state-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(root);
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
  const authority = control.retainAdmittedControlExecution(dm, input);
  const cell = join(
    root,
    "control-private/data-manager/observations",
    `phase-${execution.operationKey}-0.json`,
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
    control.cancelControlExecution(f.authority);
    vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
    expect(await control.bindControlChildPhase(f.authority, phase)).toEqual(first);
    await expect(
      control.bindControlChildPhase(f.authority, { phase: "stop-staging", ordinal: 1 }),
    ).rejects.toThrow(/fenced|clock|expir/i);
    expect(control.lookupControlChildPhase(f.authority, phase)).toEqual(first);
  } finally {
    f.close();
  }
});
it("observes one same-slot binding and rejects signed-cell rollback against the retained physical index", async () => {
  const f = await fixture();
  try {
    const unbound = readFileSync(f.cell),
      phase = { phase: "stop-primary" as const, ordinal: 0 };
    const results = await Promise.all([
      control.bindControlChildPhase(f.authority, phase),
      control.bindControlChildPhase(f.authority, phase),
    ]);
    expect(results[0]).toEqual(results[1]);
    writeFileSync(f.cell, unbound);
    expect(() => control.lookupControlChildPhase(f.authority, phase)).toThrow(/record.*changed/);
    await expect(control.bindControlChildPhase(f.authority, phase)).rejects.toThrow(
      /record.*changed/,
    );
  } finally {
    f.close();
  }
});
it("keeps an old exact admission's signed bytes when a duplicate supplies empty reservations", async () => {
  const f = await fixture(true);
  try {
    const path = join(
        f.root,
        "control-private/data-manager/executions",
        `${f.execution.operationKey}.json`,
      ),
      original = readFileSync(path);
    const repeated = control.retainAdmittedControlExecution(f.dm, { ...f.input, reservations: [] });
    expect(repeated.execution).toEqual(f.execution);
    expect(readFileSync(path)).toEqual(original);
  } finally {
    f.close();
  }
});

import { AnchoredDirectory } from "./filesystem";

it.each([
  "reference",
  "cancellation-index",
  "lease-outbox",
  "grant-outbox",
  "shared-grant",
  "parent-linkage",
] as const)(
  "retains the exact phase and refuses another dispatch after a crash at %s",
  async (point) => {
    const f = await fixture(),
      agent = control.openControlInstallation({
        infraDir: f.root,
        role: "ops-agent",
        serviceIds: ["motis", "motis-staging"],
      }),
      lease = await control.acquireArtifactTargetLease({
        dataRoot: join(f.root, "data"),
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
          ((point === "reference" &&
            path.endsWith("/observations") &&
            name.startsWith("phase-") &&
            text.includes('"grant_prepared"')) ||
            (point === "cancellation-index" &&
              path.endsWith("/execution-lifecycle") &&
              text.includes('"leaseIntents":{')) ||
            (point === "lease-outbox" &&
              path.endsWith("/parent-attempts") &&
              text.includes('"kind":"lease"')) ||
            (point === "grant-outbox" && path.endsWith("/attempts")) ||
            (point === "shared-grant" && path.endsWith("/grants")) ||
            (point === "parent-linkage" &&
              path.endsWith(`/${lease.leaseId}`) &&
              name === "owner.json" &&
              text.includes('"grantDigests":{') &&
              !text.includes('"grantDigests":{}')));
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
          childPublicKey: agent.publicKey,
        }),
      ).rejects.toThrow();
      fault.mockRestore();
      expect(fired).toBe(true);
      // An ambiguous indexed write is recovery-required; a fully indexed reference
      // is readable but never issues another nominal ticket or mutation.
      try {
        expect(control.lookupControlChildPhase(f.authority, phase)?.execution).toEqual(
          bound.execution,
        );
      } catch (error) {
        expect(String(error)).toMatch(/retained|record|changed|identity/i);
      }
      await expect(
        control.issueControlChildPhase(f.authority, {
          ...phase,
          lease,
          childPublicKey: agent.publicKey,
        }),
      ).rejects.toThrow();
      try {
        expect(control.cancelControlExecution(f.authority)).toContainEqual(bound.execution);
      } catch {
        /* Torn private/shared publication is itself a closed recovery fence. */
      }
      expect(() => control.assertControlExecutionForward(f.authority)).toThrow();
      expect(statSync(join(f.root, "data/.admin-target-control/locks/motis")).isDirectory()).toBe(
        true,
      );
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
      expect(() =>
        control.retainAdmittedControlExecution(f.dm, { ...f.input, reservations }),
      ).toThrow();
      expect(
        control.lookupControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
      ).toBeNull();
      expect(readFileSync(f.cell)).toEqual(original);
    } finally {
      f.close();
    }
  },
);
it.each(["version", "domain", "origin", "missing"] as const)(
  "rejects %s phase evidence rather than binding a new identity",
  async (field) => {
    const f = await fixture();
    try {
      if (field === "missing") rmSync(f.cell);
      else {
        const raw = JSON.parse(readFileSync(f.cell, "utf8"));
        if (field === "version") raw.payload.version = 1;
        if (field === "domain") raw.signature = "a".repeat(86);
        if (field === "origin") raw.payload.origin.notAfter++;
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
      dataRoot: join(f.root, "data"),
      serviceIds: ["motis", "motis-staging"],
      owner: f.authority,
    });
  let fired = false;
  try {
    const phase = { phase: "stop-primary" as const, ordinal: 0 };
    await control.bindControlChildPhase(f.authority, phase);
    const original = AnchoredDirectory.prototype.name;
    vi.spyOn(AnchoredDirectory.prototype, "name").mockImplementation(function (
      this: AnchoredDirectory,
      name: string,
    ) {
      if (!fired && name === ".journal-writer" && this.path.endsWith(`/${lease.leaseId}`)) {
        fired = true;
        control.cancelControlExecution(f.authority);
      }
      return original.call(this, name);
    });
    await expect(
      control.issueControlChildPhase(f.authority, {
        ...phase,
        lease,
        childPublicKey: agent.publicKey,
      }),
    ).rejects.toThrow(/fenced|cancel/i);
    expect(fired).toBe(true);
    expect(inspectControlChildPublication(f.authority, phase).publication.state).toBe("unissued");
    expect(control.cancelControlExecution(f.authority)).toEqual([]);
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
      process.stdin.end(JSON.stringify({ root: f.root, execution: f.execution }) + "\n");
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
    const bound = control.lookupControlChildPhase(f.authority, {
      phase: "stop-primary",
      ordinal: 0,
    });
    expect(bound).not.toBeNull();
    for (const result of results)
      if (result.ok) expect(result.child).toEqual(bound);
      else expect(result.error).toMatch(/busy|writer/);
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
      ...f.input.reservations![0]!,
      ordinal,
      execution: {
        ...f.input.reservations![0]!.execution,
        operationKey: control.controlChildOperationKey(
          f.execution.operationKey,
          "stop-primary",
          Math.min(ordinal, 63),
        ),
      },
    }));
    expect(() =>
      control.retainAdmittedControlExecution(f.dm, { ...f.input, reservations }),
    ).toThrow();
    expect(
      control.lookupControlChildPhase(f.authority, { phase: "stop-primary", ordinal: 0 }),
    ).toBeNull();
  } finally {
    f.close();
  }
});

it.each(["cell", "aggregate"] as const)(
  "reserves the signed %s capacity before any forward exposure",
  async (limit) => {
    const services =
        limit === "cell"
          ? Array.from(
              { length: 256 },
              (_, n) => `svc-${String(n).padStart(3, "0")}-${"a".repeat(50)}`,
            )
          : [
              "motis",
              "motis-staging",
              ...Array.from({ length: 8 }, (_, n) => `svc-${n}-${"a".repeat(50)}`),
            ],
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
        base = f.input.reservations![0]!,
        reservations = Array.from({ length: limit === "cell" ? 1 : 64 }, (_, ordinal) => ({
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
      expect(() =>
        control.retainAdmittedControlExecution(f.dm, {
          ...f.input,
          execution,
          reservations,
          serviceIds: services,
        }),
      ).toThrow(limit === "cell" ? /cell capacity/ : /aggregate capacity/);
      expect(
        (await import("node:fs")).existsSync(
          join(
            f.root,
            "data/.admin-target-control/executions/data-manager",
            `${execution.operationKey}.json`,
          ),
        ),
      ).toBe(false);
    } finally {
      f.close();
    }
  },
  30000,
);

async function deadlineFixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-fixed-phase-ancestry-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(root);
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
    operation = { kind: "data.downloadFonts" as const },
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
    authority = control.retainAdmittedControlExecution(agent, {
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
    childPublicKey = control.prepareFixedControlChild(authority, plan.delegationId),
    args = control.fixedCliArguments(operation);
  control.retainFixedCliSpawnIntent(authority, {
    delegationId: plan.delegationId,
    execution: bound.execution,
    operation,
    args,
    reservations: plan.cliReservations,
  });
  const issued = await control.issueControlChildPhase(authority, {
    ...plan.rootReservation,
    childPublicKey,
  });
  control.consumeControlChildDispatch(issued.dispatchTicket);
  const cli = control.openFixedChildInstallation({ infraDir: root, assertion: issued.assertion }),
    intent = control.readFixedCliSpawnIntent(cli, bound.execution, args),
    peer = control.verifyFixedCliControlPeer(cli, {
      assertion: issued.assertion,
      execution: bound.execution,
      kind: operation.kind,
    }),
    parent = control.verifyParentExecution(issued.assertion, peer, {
      execution: bound.execution,
      kind: operation.kind,
      requestedDeadlineAt: bound.execution.deadlineAt,
    }),
    cliAuthority = control.retainAdmittedControlExecution(cli, {
      execution: bound.execution,
      kind: operation.kind,
      operation,
      admittedAt: intent.admittedAt,
      requestedDeadlineAt: bound.execution.deadlineAt,
      parent,
      serviceIds: intent.serviceIds,
      reservations: intent.reservations,
    });
  control.beginFixedCliExecution(cli, bound.execution);
  return {
    root,
    agent,
    dm,
    cli,
    authority,
    execution,
    cliAuthority,
    slot: plan.cliReservations[0]!,
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
      expect(
        (await import("node:fs")).existsSync(
          join(f.root, "data/.admin-target-control/locks/data-manager"),
        ),
      ).toBe(false);
      if (order === "cancel-first") {
        const original = AnchoredDirectory.prototype.name;
        vi.spyOn(AnchoredDirectory.prototype, "name").mockImplementation(function (
          this: AnchoredDirectory,
          name: string,
        ) {
          if (
            !fired &&
            name === `${f.execution.operationKey}.writer` &&
            this.path.endsWith("/ops-agent")
          ) {
            fired = true;
            control.cancelControlExecution(f.authority);
          }
          return original.call(this, name);
        });
        await expect(
          control.issueControlChildPhase(f.cliAuthority, {
            ...f.slot,
            childPublicKey: f.dm.publicKey,
          }),
        ).rejects.toThrow(/cancel|fenced/i);
        expect(fired).toBe(true);
        expect(inspectControlChildPublication(f.cliAuthority, f.slot).publication.state).toBe(
          "unissued",
        );
        expect(control.cancelControlExecution(f.cliAuthority)).toEqual([]);
      } else {
        const issued = await control.issueControlChildPhase(f.cliAuthority, {
          ...f.slot,
          childPublicKey: f.dm.publicKey,
        });
        control.cancelControlExecution(f.authority);
        expect(control.cancelControlExecution(f.cliAuthority)).toEqual([bound.execution]);
        expect(() => control.consumeControlChildDispatch(issued.dispatchTicket)).toThrow(
          /cancel|fenced/i,
        );
        expect(control.lookupControlChildPhaseAttempt(f.cliAuthority, f.slot)?.execution).toEqual(
          bound.execution,
        );
      }
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
  30000,
);
