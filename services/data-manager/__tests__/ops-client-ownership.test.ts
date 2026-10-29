import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogPinSet } from "@openmapx/core/catalog-pins";
import { OpsClient } from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { resetOpsClient, runOpsOperation } from "../src/ops-client.js";

it("refuses an unowned synchronous proposal before the actual client POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-proposal-owner-")),
    tokenFile = join(root, "token");
  writeFileSync(tokenFile, "a".repeat(43), { mode: 0o600 });
  let posts = 0;
  const operation = {
    kind: "transitousLock.propose" as const,
    proposalId: "00000000-0000-4000-8000-000000000001",
    baseGenerationId: null,
    diffDigest: "d".repeat(64),
    sourcePolicyRevision: "e".repeat(64),
    pins: createCatalogPinSet(
      {
        ref: `main@${"a".repeat(40)}`,
        submodules: { "transitland-atlas": "b".repeat(40) },
        lockedAt: "2026-10-23T00:00:00.000Z",
        lockedBy: "fixture",
      },
      {
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit: "c".repeat(40),
        sha256: "d".repeat(64),
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
        lockedAt: "2026-10-23T00:00:00.000Z",
        lockedBy: "fixture",
      },
    ),
  };
  resetOpsClient(
    new OpsClient({
      baseUrl: "http://127.0.0.1:4300",
      tokenFile,
      fetch: async (_url, options) => {
        if (options?.method === "GET")
          return Response.json({
            version: 1,
            requestId: new Headers(options.headers).get("x-ops-request-id"),
            ok: true,
            result: { versions: [1, 2] },
          });
        posts++;
        const request = JSON.parse(String(options?.body));
        return Response.json({
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: {
            execution: "sync",
            kind: operation.kind,
            value: {
              proposalId: operation.proposalId,
              catalogRevisionId: operation.pins.generationId,
              proposed: true,
            },
          },
        });
      },
    }),
  );
  try {
    await expect(runOpsOperation(operation)).rejects.toThrow(/retained.*owner|retained.*mutation/i);
    expect(posts).toBe(0);
  } finally {
    resetOpsClient();
    rmSync(root, { recursive: true, force: true });
  }
});
