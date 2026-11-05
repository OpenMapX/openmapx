import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { createCatalogPinSet, initializeManagedCatalogPins } from "@openmapx/core/catalog-pins";
import { opsOperationSchema } from "@openmapx/core/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";

const roots: string[] = [];
const REF = `main@${"a".repeat(40)}`;

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-lock-runtime-"));
  roots.push(directory);
  mkdirSync(join(directory, "infra", "docker"), { mode: 0o755, recursive: true });
  return directory;
}

function context() {
  return {
    execution: testExecution(),
    signal: new AbortController().signal,
    emitLog: vi.fn(),
    claim: {
      fingerprint: "f".repeat(64),
      operation: {} as never,
      source: "registry" as const,
      capability: { revisionId: "registry-v1", values: {} },
    },
  };
}

function runtimeFor(rootDir: string) {
  return createTransitousLockRuntime(createUnavailableRuntime(), {
    rootDir,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
}

function lockPath(rootDir: string): string {
  return join(rootDir, "infra", "docker", "transitous.lock.json");
}

function proposedPath(rootDir: string): string {
  return join(rootDir, "infra", "docker", "transitous.lock.proposed.json");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("agent-owned Transitous catalog lock", () => {
  it("retains a paired GBFS-only proposal without changing active pins", async () => {
    const rootDir = root(),
      infra = join(rootDir, "infra/docker");
    mkdirSync(join(infra, "data"), { mode: 0o700 });
    await provisionControlInstallation(infra);
    const pins = createCatalogPinSet(
      {
        ref: REF,
        submodules: { "transitland-atlas": "c".repeat(40) },
        lockedAt: "2026-08-25T00:00:00.000Z",
        lockedBy: "fixture",
      },
      {
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit: "d".repeat(40),
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"d".repeat(40)}/systems.csv`,
        sha256: "e".repeat(64),
        lockedAt: "2026-08-25T00:00:00.000Z",
        lockedBy: "fixture",
      },
    );
    const operation = opsOperationSchema.parse({
      kind: "transitousLock.propose",
      proposalId: "00000000-0000-4000-8000-000000000001",
      baseGenerationId: null,
      pins,
      diffDigest: "f".repeat(64),
      sourcePolicyRevision: "a".repeat(64),
    });
    const result = await dispatchOpsOperation(runtimeFor(rootDir), operation, context());
    expect(result).toMatchObject({
      proposalId: "00000000-0000-4000-8000-000000000001",
      proposed: true,
      catalogRevisionId: pins.generationId,
    });
    expect(existsSync(lockPath(rootDir))).toBe(false);
    const retained = JSON.parse(
      readFileSync(
        join(infra, "catalog-pins/proposals/00000000-0000-4000-8000-000000000001.json"),
        "utf8",
      ),
    );
    expect(retained.payload.proposal.pins.gbfs.commit).toBe("d".repeat(40));
    expect(retained.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const originalBytes = readFileSync(
      join(infra, "catalog-pins/proposals/00000000-0000-4000-8000-000000000001.json"),
      "utf8",
    );
    await expect(dispatchOpsOperation(runtimeFor(rootDir), operation, context())).resolves.toEqual(
      result,
    );
    const changedPins = createCatalogPinSet(pins.transitous, {
      ...pins.gbfs,
      commit: "f".repeat(40),
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"f".repeat(40)}/systems.csv`,
    });
    await expect(
      dispatchOpsOperation(
        runtimeFor(rootDir),
        opsOperationSchema.parse({ ...operation, pins: changedPins }),
        context(),
      ),
    ).rejects.toThrow(/Immutable catalog proposal changed/);
    expect(
      readFileSync(
        join(infra, "catalog-pins/proposals/00000000-0000-4000-8000-000000000001.json"),
        "utf8",
      ),
    ).toBe(originalBytes);
    await expect(
      dispatchOpsOperation(
        runtimeFor(rootDir),
        opsOperationSchema.parse({
          ...operation,
          proposalId: "00000000-0000-4000-8000-000000000002",
          baseGenerationId: "b".repeat(64),
        }),
        context(),
      ),
    ).rejects.toThrow(/base changed/);
    expect(
      existsSync(join(infra, "catalog-pins/proposals/00000000-0000-4000-8000-000000000002.json")),
    ).toBe(false);
  });

  it("reports both slots as absent on a fresh checkout", async () => {
    const rootDir = root();
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).resolves.toEqual({ active: null, proposed: null });
  });

  it("refuses legacy one-pin proposal bodies", () => {
    expect(
      opsOperationSchema.safeParse({
        kind: "transitousLock.propose",
        ref: REF,
        submodules: { "transitland-atlas": "c".repeat(40) },
        lockedBy: "auto-bump",
      }).success,
    ).toBe(false);
  });

  it("keeps approval closed until durable paired-pin publication is installed", async () => {
    const rootDir = root();
    const runtime = runtimeFor(rootDir);
    for (const proposalId of [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ])
      await expect(
        dispatchOpsOperation(
          runtime,
          {
            kind: "transitousLock.approve",
            proposalId,
            validationId: "00000000-0000-4000-8000-000000000003",
            expectedGenerationId: null,
            diffDigest: "a".repeat(64),
            acknowledgeLicenseChanges: false,
          },
          context(),
        ),
      ).rejects.toThrow(/paired-pin/);
    expect(existsSync(lockPath(rootDir))).toBe(false);
    expect(existsSync(proposedPath(rootDir))).toBe(false);
  });

  it("reads back an existing active lock", async () => {
    const rootDir = root();
    writeFileSync(
      lockPath(rootDir),
      JSON.stringify({
        ref: REF,
        submodules: { "transitland-atlas": "d".repeat(40) },
        lockedAt: "2026-01-01T00:00:00.000Z",
        lockedBy: "operator",
        comment: "pinned",
      }),
      { mode: 0o644 },
    );
    const commit = "b".repeat(40);
    writeFileSync(
      join(rootDir, "infra/docker/gbfs-catalog.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit,
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${commit}/systems.csv`,
        sha256: "c".repeat(64),
        lockedAt: "2026-01-01T00:00:00.000Z",
        lockedBy: "fixture",
      }),
      { mode: 0o644 },
    );
    const infra = join(rootDir, "infra/docker");
    mkdirSync(join(infra, "data"), { mode: 0o700 });
    await provisionControlInstallation(infra);
    const installation = openControlInstallation({
      infraDir: infra,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    try {
      await initializeManagedCatalogPins({ rootDir, installation });
    } finally {
      closeControlInstallation(installation);
    }
    const result = (await dispatchOpsOperation(
      runtimeFor(rootDir),
      { kind: "transitousLock.inspect" },
      context(),
    )) as { active: { ref: string; comment?: string } | null };
    expect(result.active).toMatchObject({ ref: REF, lockedBy: "operator", comment: "pinned" });
  });

  it("rejects an oversized lock rather than loading it", async () => {
    const rootDir = root();
    writeFileSync(lockPath(rootDir), `{"ref":"${"x".repeat(300_000)}"}`, { mode: 0o644 });
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).rejects.toThrow(/not wired/i);
  });
});
