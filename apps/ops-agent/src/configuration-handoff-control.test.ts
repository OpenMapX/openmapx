import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  openFixedChildInstallation: vi.fn(),
  readConfigurationHandoffSpawnIntent: vi.fn(),
  verifyFixedCliControlPeer: vi.fn(),
  verifiedParentForArtifactDelegation: vi.fn(),
  adoptArtifactTargetLease: vi.fn(),
  retainAdmittedControlExecution: vi.fn(),
  bindBorrowedControlExecution: vi.fn(),
  assertArtifactTargetLeaseExecution: vi.fn(),
  beginFixedCliExecution: vi.fn(),
  closeArtifactTargetLeaseHandle: vi.fn(),
  closeControlInstallation: vi.fn(),
  executionAuthorityState: vi.fn(),
}));
vi.mock("@openmapx/core/build-artifacts", async (original) => ({
  ...(await original<typeof import("@openmapx/core/build-artifacts")>()),
  ...mock,
}));
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}));

import {
  ArtifactTargetAdoptionObservationBusyError,
  ArtifactTargetJournalBusyError,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import {
  closeConfigurationHandoffChild,
  openConfigurationHandoffChild,
} from "./configuration-handoff-control";

// These mocks isolate retry/cleanup control flow. The target-lease filesystem
// tests and native platform suite verify the actual authority and adoption.
function fixture() {
  const deadlineAt = Date.now() + 60000,
    execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: "11111111-1111-4111-8111-111111111111",
      operationKey: createControlRootOperationKey({
        notAfter: deadlineAt,
        nonce: Buffer.alloc(16),
      }),
      operationFingerprint: "a".repeat(64),
      fingerprint: "b".repeat(64),
      deadlineAt,
    },
    input = {
      rootDir: "/synthetic/owned-deployment",
      handoffId: "22222222-2222-4222-8222-222222222222",
      assertion: "original-fixed-child-assertion",
      execution,
    },
    installation = { installationId: "fixture-installation", publicKey: "original-child-key" },
    preparer = { operationKey: "original-preparer", fingerprint: "c".repeat(64) },
    peer = Object.freeze({ fixture: "original-peer" }),
    lease = Object.freeze({ fixture: "original-lease" });
  mock.openFixedChildInstallation.mockReturnValue(installation);
  mock.readConfigurationHandoffSpawnIntent.mockReturnValue({
    installationId: installation.installationId,
    operation: { handoffId: input.handoffId, serviceIds: ["motis"] },
    assertion: input.assertion,
    helperPublicKey: installation.publicKey,
    helper: execution,
    preparer,
    admittedAt: Date.now(),
    requestedDeadlineAt: deadlineAt,
  });
  mock.verifyFixedCliControlPeer.mockReturnValue(peer);
  mock.verifiedParentForArtifactDelegation.mockReturnValue(preparer);
  mock.adoptArtifactTargetLease.mockResolvedValue(lease);
  mock.retainAdmittedControlExecution.mockReturnValue(Object.freeze({ fixture: "authority" }));
  return { input, installation, peer, lease };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it.each([
  () => new ArtifactTargetAdoptionObservationBusyError(Error("held observation guard")),
  () => new ArtifactTargetJournalBusyError(Error("held journal guard")),
])("retries only a nominal pre-adoption refusal with the original identity", async (busy) => {
  const f = fixture();
  mock.adoptArtifactTargetLease.mockRejectedValueOnce(busy());
  const pending = openConfigurationHandoffChild(f.input);
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(50);
  const child = await pending;
  try {
    expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(2);
    const [first, second] = mock.adoptArtifactTargetLease.mock.calls;
    expect(second).toEqual(first);
    expect(second?.[0].peer).toBe(first?.[0].peer);
    expect(first?.[0]).toMatchObject({
      assertion: f.input.assertion,
      execution: f.input.execution,
      peer: f.peer,
      serviceIds: ["motis"],
    });
    expect(mock.retainAdmittedControlExecution).toHaveBeenCalledTimes(1);
    expect(mock.beginFixedCliExecution).toHaveBeenCalledTimes(1);
  } finally {
    closeConfigurationHandoffChild(child);
  }
});

it("stops at the five-second contention budget without adopting or retaining authority", async () => {
  const f = fixture(),
    error = new ArtifactTargetAdoptionObservationBusyError(Error("persistent guard"));
  mock.adoptArtifactTargetLease.mockRejectedValue(error);
  const failed = expect(openConfigurationHandoffChild(f.input)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(5050);
  await failed;
  expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(101);
  expect(mock.retainAdmittedControlExecution).not.toHaveBeenCalled();
  expect(mock.beginFixedCliExecution).not.toHaveBeenCalled();
  expect(mock.closeControlInstallation).toHaveBeenCalledExactlyOnceWith(f.installation);
});

it("stops at the original deadline before the five-second wait budget", async () => {
  const f = fixture(),
    error = new ArtifactTargetAdoptionObservationBusyError(Error("held guard"));
  f.input.execution.deadlineAt = Date.now() + 20;
  mock.adoptArtifactTargetLease.mockRejectedValue(error);
  const failed = expect(openConfigurationHandoffChild(f.input)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(2);
  for (const [input] of mock.adoptArtifactTargetLease.mock.calls)
    expect(input.execution.deadlineAt).toBe(f.input.execution.deadlineAt);
  expect(mock.retainAdmittedControlExecution).not.toHaveBeenCalled();
  expect(mock.closeControlInstallation).toHaveBeenCalledExactlyOnceWith(f.installation);
});

it("propagates raw family contention after exactly one adoption attempt", async () => {
  const f = fixture(),
    error = Object.assign(Error("family writer busy after adoption started"), {
      code: "EEXIST",
      syscall: "mkdir",
      path: "/synthetic/.family-writer",
    });
  mock.adoptArtifactTargetLease.mockRejectedValueOnce(error);
  await expect(openConfigurationHandoffChild(f.input)).rejects.toBe(error);
  expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(1);
  expect(mock.retainAdmittedControlExecution).not.toHaveBeenCalled();
  expect(mock.closeControlInstallation).toHaveBeenCalledExactlyOnceWith(f.installation);
});

it("does not retry any failure after the one-use execution marker", async () => {
  const f = fixture(),
    error = Error("one-use marker publication refused");
  mock.beginFixedCliExecution.mockImplementation(() => {
    throw error;
  });
  await expect(openConfigurationHandoffChild(f.input)).rejects.toBe(error);
  expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(1);
  expect(mock.beginFixedCliExecution).toHaveBeenCalledTimes(1);
  expect(mock.closeArtifactTargetLeaseHandle).toHaveBeenCalledExactlyOnceWith(f.lease);
  expect(mock.closeControlInstallation).toHaveBeenCalledExactlyOnceWith(f.installation);
});

it("keeps the existing raw family-writer wait limited to source reads", async () => {
  const f = fixture(),
    error = Object.assign(Error("source writer busy"), {
      code: "EEXIST",
      syscall: "mkdir",
      path: "/synthetic/.family-writer",
    });
  mock.readConfigurationHandoffSpawnIntent.mockImplementationOnce(() => {
    throw error;
  });
  const pending = openConfigurationHandoffChild(f.input);
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(50);
  closeConfigurationHandoffChild(await pending);
  expect(mock.readConfigurationHandoffSpawnIntent).toHaveBeenCalledTimes(2);
  expect(mock.adoptArtifactTargetLease).toHaveBeenCalledTimes(1);
});
