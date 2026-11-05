import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { type ExecutionRef, executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import * as c from "./control-authority";
import { AnchoredDirectory } from "./filesystem";
import { reserveControlFamily } from "./retention-family";
import * as a from "./target-lease";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function adoptionFixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-adoption-observation-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
  const dm = c.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["motis"],
    }),
    agent = c.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
  cleanups.push(
    () => c.closeControlInstallation(dm),
    () => c.closeControlInstallation(agent),
  );
  const operation = { kind: "transit-sync", countries: ["de"] },
    admittedAt = Date.now(),
    deadlineAt = admittedAt + 60000,
    operationFingerprint = c.controlDigest(operation),
    execution: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    },
    body = { kind: "motis.primary.stop" as const },
    childFingerprint = opsOperationFingerprint(body),
    child: ExecutionRef = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: c.controlChildOperationKey(execution.operationKey, "stop-primary", 0),
      operationFingerprint: childFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: body.kind,
        operationFingerprint: childFingerprint,
        deadlineAt,
        parent: c.retainedControlParent(execution),
      }),
    },
    plan = {
      phase: "stop-primary" as const,
      ordinal: 0,
      kind: body.kind,
      execution: child,
      serviceIds: ["motis"],
      recipient: "ops-agent" as const,
    },
    owner = c.retainAdmittedControlExecution(dm, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["motis"],
      plan: [plan],
    }),
    lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["motis"],
      owner,
    });
  cleanups.push(() => a.closeArtifactTargetLeaseHandle(lease));
  const assertion = await a.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: agent.publicKey,
    }),
    inspected = a.inspectArtifactDelegation({
      dataRoot: join(root, "data"),
      assertion,
      installation: agent,
    });
  if (!inspected.origin) throw Error("Expected certified fixture origin");
  reserveControlFamily(c.installationState(agent), inspected.origin);
  a.inspectArtifactDelegation({ dataRoot: join(root, "data"), assertion, installation: agent });
  const peer = c.verifyControlPeer(agent, {
      rawHeaders: ["x-openmapx-control-delegation", assertion],
      transportPrincipal: "data-manager",
      execution: child,
      kind: body.kind,
    }),
    privateRoot = join(root, "control-private/ops-agent"),
    families = join(privateRoot, "retention-families"),
    slots = readdirSync(families).filter((name) => /^slot-\d+$/.test(name));
  expect(slots).toHaveLength(1);
  const family = join(families, slots[0]!),
    ledger = join(root, "data/.admin-target-control/leases", lease.leaseId);
  return {
    input: {
      dataRoot: join(root, "data"),
      assertion,
      peer,
      execution: child,
      serviceIds: ["motis"],
    },
    observation: join(privateRoot, "observations", `${lease.leaseId}.json`),
    adoption: join(privateRoot, "adoptions", `${inspected.delegationId}.json`),
    child: join(ledger, "children", `${inspected.delegationId}.json`),
    journalGuard: join(ledger, ".journal-writer"),
    family,
    familyGuard: join(family, ".family-writer"),
    clockGuard: join(privateRoot, ".retention-clock-writer"),
  };
}

function familySnapshot(family: string) {
  return Object.fromEntries(
    readdirSync(family)
      .filter((name) => name === "progress.json" || /^page-\d+\.json$/.test(name))
      .sort()
      .map((name) => [name, readFileSync(join(family, name))]),
  );
}

it("distinguishes initial observation contention without changing any adoption or family record", async () => {
  const f = await adoptionFixture(),
    observation = readFileSync(f.observation),
    before = familySnapshot(f.family);
  mkdirSync(f.familyGuard, { mode: 0o700 });
  const held = statSync(f.familyGuard);
  try {
    const error = await a.adoptArtifactTargetLease(f.input).catch((error: Error) => error);
    expect(error).toBeInstanceOf(a.ArtifactTargetAdoptionObservationBusyError);
    expect(error).toMatchObject({
      message: "Lease adoption observation is busy or requires supervised recovery",
      cause: { code: "EEXIST", syscall: "mkdir", path: expect.stringContaining(".family-writer") },
    });
    expect(readFileSync(f.observation)).toEqual(observation);
    expect(familySnapshot(f.family)).toEqual(before);
    expect(existsSync(f.journalGuard)).toBe(false);
    expect(statSync(f.familyGuard)).toMatchObject({ dev: held.dev, ino: held.ino });
    expect(existsSync(f.adoption)).toBe(false);
    expect(existsSync(f.child)).toBe(false);
  } finally {
    rmdirSync(f.familyGuard);
  }
  const adopted = await a.adoptArtifactTargetLease(f.input);
  cleanups.push(() => a.closeArtifactTargetLeaseHandle(adopted));
  expect(JSON.parse(readFileSync(f.adoption, "utf8"))).toMatchObject({
    state: "ready",
    execution: f.input.execution,
  });
  expect(readdirSync(dirname(f.adoption)).filter((name) => name.endsWith(".json"))).toEqual([
    basename(f.adoption),
  ]);
  expect(readdirSync(dirname(f.child)).filter((name) => name.endsWith(".json"))).toEqual([
    basename(f.child),
  ]);
});

it("keeps late family contention raw and retains the already published pending adoption", async () => {
  const f = await adoptionFixture(),
    family = statSync(f.family, { bigint: true }),
    write = AnchoredDirectory.prototype.write,
    remove = AnchoredDirectory.prototype.removeDirectory;
  let pending: Buffer | undefined,
    armed = false,
    held: ReturnType<typeof statSync> | undefined;
  vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
    this: AnchoredDirectory,
    ...args
  ) {
    const result = write.apply(this, args);
    if (
      args[0] === basename(f.adoption) &&
      this.path.endsWith("/adoptions") &&
      JSON.parse(args[1].toString()).state === "pending-adoption"
    ) {
      pending = readFileSync(f.adoption);
      armed = true;
    }
    return result;
  });
  vi.spyOn(AnchoredDirectory.prototype, "removeDirectory").mockImplementation(function (
    this: AnchoredDirectory,
    ...args
  ) {
    const result = remove.apply(this, args);
    if (
      armed &&
      args[0] === ".family-writer" &&
      this.stat.dev === family.dev &&
      this.stat.ino === family.ino
    ) {
      armed = false;
      mkdirSync(f.familyGuard, { mode: 0o700 });
      held = statSync(f.familyGuard);
    }
    return result;
  });
  try {
    const error = await a.adoptArtifactTargetLease(f.input).catch((error: Error) => error);
    expect(error).toMatchObject({ code: "EEXIST", syscall: "mkdir" });
    expect(error).not.toBeInstanceOf(a.ArtifactTargetAdoptionObservationBusyError);
    expect(error).not.toBeInstanceOf(a.ArtifactTargetJournalBusyError);
    expect(pending).toBeDefined();
    expect(readFileSync(f.adoption)).toEqual(pending);
    expect(JSON.parse(readFileSync(f.adoption, "utf8")).state).toBe("pending-adoption");
    expect(existsSync(f.child)).toBe(false);
    expect(existsSync(f.journalGuard)).toBe(false);
    expect(held).toBeDefined();
    expect(statSync(f.familyGuard)).toMatchObject({ dev: held?.dev, ino: held?.ino });
  } finally {
    if (held) rmdirSync(f.familyGuard);
  }
});

it("keeps retention-clock contention after the initial observation raw", async () => {
  const f = await adoptionFixture();
  mkdirSync(f.clockGuard, { mode: 0o700 });
  const held = statSync(f.clockGuard);
  try {
    const error = await a.adoptArtifactTargetLease(f.input).catch((error: Error) => error);
    expect(error).toMatchObject({
      code: "EEXIST",
      syscall: "mkdir",
      path: expect.stringContaining(".retention-clock-writer"),
    });
    expect(error).not.toBeInstanceOf(a.ArtifactTargetAdoptionObservationBusyError);
    expect(error).not.toBeInstanceOf(a.ArtifactTargetJournalBusyError);
    expect(existsSync(f.adoption)).toBe(false);
    expect(existsSync(f.child)).toBe(false);
    expect(existsSync(f.journalGuard)).toBe(false);
    expect(statSync(f.clockGuard)).toMatchObject({ dev: held.dev, ino: held.ino });
  } finally {
    rmdirSync(f.clockGuard);
  }
});
