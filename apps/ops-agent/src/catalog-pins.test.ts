import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { createCatalogPinSet, initializeManagedCatalogPins } from "@openmapx/core/catalog-pins";
import { OpsClient } from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { createRegistryResourcePolicy, denyAllTrustedOpsData } from "./policy";
import { createUnavailableRuntime } from "./runtime";
import { buildOpsAgentServer } from "./server";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";

it("serializes the largest legal paired pins through the actual HTTP server/client for both read roles", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-pins-http-")),
    infra = join(root, "infra/docker");
  mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
  const apiToken = Buffer.alloc(32, 1).toString("base64url"),
    dmToken = Buffer.alloc(32, 2).toString("base64url");
  const t = {
    ref: `${"a".repeat(215)}@${"b".repeat(40)}`,
    submodules: Object.fromEntries(
      Array.from({ length: 128 }, (_, n) => [
        n === 0 ? "transitland-atlas" : `${"x".repeat(253)}${String(n).padStart(3, "0")}`,
        "c".repeat(40),
      ]),
    ),
    lockedAt: "2026-10-23T00:00:00.000Z",
    lockedBy: "x".repeat(128),
    comment: "💠".repeat(256),
  };
  const commit = "d".repeat(40),
    g = {
      schemaVersion: 1 as const,
      source: "mobilitydata-gbfs" as const,
      commit,
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${commit}/systems.csv`,
      sha256: "e".repeat(64),
      lockedAt: t.lockedAt,
      lockedBy: t.lockedBy,
    };
  writeFileSync(join(infra, "transitous.lock.json"), JSON.stringify(t));
  writeFileSync(join(infra, "gbfs-catalog.lock.json"), JSON.stringify(g));
  await provisionControlInstallation(infra);
  const installation = openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const runtime = createTransitousLockRuntime(createUnavailableRuntime(), { rootDir: root });
  const app = buildOpsAgentServer({
    tokens: { api: apiToken, "data-manager": dmToken },
    runtime,
    resourcePolicy: createRegistryResourcePolicy({
      serviceIds: ["motis"],
      integrationIds: [],
      trustedData: denyAllTrustedOpsData,
    }),
  });
  try {
    await initializeManagedCatalogPins({ rootDir: root, installation });
    const expected = createCatalogPinSet(t, g);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const [role, token] of [
      ["api", apiToken],
      ["data-manager", dmToken],
    ]) {
      const tokenFile = join(root, `${role}.token`);
      writeFileSync(tokenFile, token, { mode: 0o600 });
      const client = new OpsClient({ baseUrl, tokenFile });
      const response = await client.execute({ kind: "catalogPins.inspect" });
      expect(response).toEqual({
        execution: "sync",
        kind: "catalogPins.inspect",
        value: { active: expected, catalogRevisionId: expected.generationId },
      });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(38000);
      if (role === "api")
        await expect(
          client.execute({
            kind: "transitousLock.propose",
            proposalId: "00000000-0000-4000-8000-000000000001",
            baseGenerationId: expected.generationId,
            pins: expected,
            diffDigest: "e".repeat(64),
            sourcePolicyRevision: "f".repeat(64),
          }),
        ).rejects.toMatchObject({ errorClass: "authorization" });
      else {
        await expect(client.execute({ kind: "configuration.inspect" })).rejects.toMatchObject({
          errorClass: "authorization",
        });
        const changedCommit = "f".repeat(40),
          candidate = createCatalogPinSet(t, {
            ...g,
            commit: changedCommit,
            url: `https://raw.githubusercontent.com/MobilityData/gbfs/${changedCommit}/systems.csv`,
          });
        const proposalId = "00000000-0000-4000-8000-000000000002";
        const retained = await client.execute({
          kind: "transitousLock.propose",
          proposalId,
          baseGenerationId: expected.generationId,
          pins: candidate,
          diffDigest: "e".repeat(64),
          sourcePolicyRevision: "f".repeat(64),
        });
        expect(retained).toMatchObject({
          execution: "sync",
          value: { proposalId, proposed: true, catalogRevisionId: candidate.generationId },
        });
        const reviewed = await client.execute({
          kind: "transitousLock.inspect",
          proposalId,
          offset: 0,
        });
        expect(reviewed).toMatchObject({
          execution: "sync",
          value: {
            proposal: { proposalId, state: "proposed", pins: candidate },
            page: { total: 1, nextOffset: null },
          },
        });
        expect(await client.execute({ kind: "catalogPins.inspect" })).toMatchObject({
          value: { active: expected },
        });
      }
    }
    expect(existsSync(join(infra, "transitous.lock.proposed.json"))).toBe(false);
  } finally {
    await app.close();
    closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
