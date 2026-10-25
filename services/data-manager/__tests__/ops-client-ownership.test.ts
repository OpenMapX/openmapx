import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    ref: `main@${"a".repeat(40)}`,
    submodules: { "transitland-atlas": "b".repeat(40) },
    lockedBy: "public-fixture",
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
            value: { ref: operation.ref, proposed: true },
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
