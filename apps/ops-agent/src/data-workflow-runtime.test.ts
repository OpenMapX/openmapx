import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { afterEach, expect, it, vi } from "vitest";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
it("freezes distinct original data/finalization slots and refuses targets before all actual data witnesses", async () => {
  const host = await ownedServiceHost({ withCoordinator: true });
  roots.push(host.cleanupRoot);
  const installation = control.openControlInstallation({
    infraDir: host.infraDir,
    role: "ops-agent",
    serviceIds: host.loaded.map((s) => s.manifest.id).sort(),
  });
  try {
    const operation = {
        kind: "data.update" as const,
        regionId: "europe/germany",
        countryCodes: ["DE"],
      },
      admittedAt = Date.now(),
      deadlineAt = admittedAt + 3600000,
      operationFingerprint = opsOperationFingerprint(operation);
    const parent = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${"a".repeat(24)}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    };
    const ids = host.loaded.map((s) => s.manifest.id).sort(),
      plan = control.planDataUpdate({
        infraDir: host.infraDir,
        parent,
        operation,
        serviceIds: ids,
      });
    expect(plan.dataChildren.map((s) => s.ordinal)).toEqual([0, 1, 2]);
    expect(plan.finalizationReservation.ordinal).toBe(1);
    const authority = control.retainAdmittedControlExecution(installation, {
      execution: parent,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ids,
      reservations: [plan.dataReservation, plan.finalizationReservation],
    });
    control.retainDataUpdatePlan(authority, plan);
    expect(control.readDataUpdatePlan(authority)).toEqual(plan);
    await expect(
      control.acquireArtifactTargetLease({
        dataRoot: join(host.infraDir, "data"),
        owner: authority,
        serviceIds: ids,
      }),
    ).rejects.toThrow("data phase not admitted");
    expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager"))).toBe(
      false,
    );
    const child = await control.bindControlChildPhase(authority, plan.dataReservation),
      key = control.prepareFixedControlChild(authority, plan.dataDelegationId);
    control.retainFixedCliSpawnIntent(authority, {
      delegationId: plan.dataDelegationId,
      execution: child.execution,
      operation,
      args: control.fixedCliArguments(operation),
      reservations: plan.dataChildren,
      dataUpdatePlan: plan,
    });
    const issued = await control.issueControlChildPhase(authority, {
      phase: "data-workflow",
      ordinal: 0,
      childPublicKey: key,
    });
    control.consumeControlChildDispatch(issued.dispatchTicket);
    // An issued original CLI is still not a completed data prerequisite.
    await expect(
      control.acquireArtifactTargetLease({
        dataRoot: join(host.infraDir, "data"),
        owner: authority,
        serviceIds: ids,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager"))).toBe(
      false,
    );
  } finally {
    control.closeControlInstallation(installation);
  }
});

it("freezes the same host .env defaults as the registered CLI, with shell precedence", async () => {
  const host = await ownedServiceHost({ withCoordinator: true });
  roots.push(host.cleanupRoot);
  writeFileSync(
    join(host.infraDir, ".env"),
    "DOMAIN=map.example.test\nOPENMAPX_REGION=europe/germany\nTRANSITOUS_COUNTRIES=DE,FR\n",
    { mode: 0o600 },
  );
  vi.stubEnv("DOMAIN", undefined);
  const operation = { kind: "data.update" as const },
    deadlineAt = Date.now() + 60000,
    operationFingerprint = opsOperationFingerprint(operation);
  const parent = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: `job1_${"b".repeat(24)}`,
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    deadlineAt,
    operationFingerprint,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const args = {
    infraDir: host.infraDir,
    parent,
    operation,
    serviceIds: host.loaded.map((s) => s.manifest.id).sort(),
  };
  expect(control.planDataUpdate(args)).toMatchObject({
    domain: "map.example.test",
    region: "europe/germany",
    countries: ["DE", "FR"],
  });
  vi.stubEnv("DOMAIN", "shell.example.test");
  expect(control.planDataUpdate(args).domain).toBe("shell.example.test");
});

it("uses adopted default regions without expanding the deployment region authority", async () => {
  const host = await ownedServiceHost({ withCoordinator: true });
  roots.push(host.cleanupRoot);
  const { services } = await import("@openmapx/core/server");
  const { createUnavailableRuntime } = await import("./runtime");
  const { installDataWorkflowRuntime, resolveDataDefaultRegion } = await import(
    "./data-workflow-runtime"
  );
  const runtime = createUnavailableRuntime();
  installDataWorkflowRuntime(runtime, { rootDir: host.root, runFixedCli: vi.fn() });
  await services.commitConfigurationGeneration({
    infraDir: host.infraDir,
    services: host.loaded,
    input: {
      ...services.readAppliedConfiguration(host.infraDir),
      domain: "fixture.example.test",
      selectedRoots: host.loaded.map((s) => s.manifest.id),
      platform: { version: 1, defaultRegion: { source: "database", value: "europe/france" } },
    },
  });
  vi.stubEnv("OPENMAPX_REGION", "europe/germany");
  vi.stubEnv("OPENMAPX_ALLOWED_REGIONS", "europe/germany");
  expect(() => resolveDataDefaultRegion(runtime)).toThrow(/allow-list/);
  vi.stubEnv("OPENMAPX_ALLOWED_REGIONS", "europe/germany,europe/france");
  expect(resolveDataDefaultRegion(runtime)).toBe("europe/france");
});
