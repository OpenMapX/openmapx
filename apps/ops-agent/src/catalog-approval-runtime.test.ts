import { expect, it } from "vitest";
import { catalogApprovalCommitId, installCatalogApprovalRuntime } from "./catalog-approval-runtime";
import { createUnavailableRuntime, type OpsExecutionContext } from "./runtime";

const operation = {
  kind: "transitousLock.approve" as const,
  proposalId: "00000000-0000-4000-8000-000000000001",
  validationId: "00000000-0000-4000-8000-000000000002",
  expectedGenerationId: null,
  diffDigest: "a".repeat(64),
  acknowledgeLicenseChanges: true,
};
it("refuses pin publication without the original nominal borrowed activation leaf", async () => {
  const runtime = createUnavailableRuntime();
  installCatalogApprovalRuntime(runtime, { rootDir: "/unused" });
  await expect(
    runtime[operation.kind](operation, {
      signal: new AbortController().signal,
    } as OpsExecutionContext),
  ).rejects.toThrow(/Original reviewed activation/);
  await expect(
    runtime[operation.kind](operation, {
      artifactLease: { mode: "borrowed", owner: { executor: "data-manager" } },
      controlAuthority: {},
      signal: new AbortController().signal,
    } as OpsExecutionContext),
  ).rejects.toThrow(/Unverified execution authority/);
});
it("gives one immutable approval attempt a stable distinct commit marker", () => {
  const key = "opk1_aaaaaaaaaaaaaaaa",
    fingerprint = "b".repeat(64);
  expect(catalogApprovalCommitId(key, fingerprint)).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(catalogApprovalCommitId(key, fingerprint)).toBe(catalogApprovalCommitId(key, fingerprint));
  expect(catalogApprovalCommitId(key, "c".repeat(64))).not.toBe(
    catalogApprovalCommitId(key, fingerprint),
  );
});
