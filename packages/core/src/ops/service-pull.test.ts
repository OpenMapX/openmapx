import { expect, it } from "vitest";
import {
  opsOperationSchema,
  parseOpsJobStatus,
  parseOpsJobStatusForKind,
  parseOpsResult,
} from "./contract";

const revisionId = `cfg1_${"a".repeat(43)}`;
it("decodes unchanged historical pull status for observation while its old result grants no fresh pull evidence", () => {
  for (const version of [1, 2]) {
    const status = {
      version,
      operationId: "job1_legacyPullObservation0",
      operationKey: "opk1_legacyPullObservation0",
      kind: "service.pull",
      resourceId: "redis",
      state: "succeeded",
      submittedAt: "2026-08-23T18:00:00.000Z",
      updatedAt: "2026-08-23T18:00:01.000Z",
      result: { changed: true },
      ...(version === 2 ? { admittedAt: 100, deadlineAt: 1000, fingerprint: "a".repeat(64) } : {}),
    };
    expect(parseOpsJobStatus(status)).toEqual(status);
    expect(parseOpsJobStatusForKind("service.pull", status)).toEqual(status);
    expect(() => parseOpsResult("service.pull", status.result)).toThrow();
  }
});
it("conditions every fresh pull on its exact current configuration and keeps candidate binding finite", () => {
  expect(
    opsOperationSchema.safeParse({ kind: "service.pull", serviceId: "data-manager" }).success,
  ).toBe(false);
  expect(
    opsOperationSchema.parse({
      kind: "service.pull",
      serviceId: "data-manager",
      expectedConfigurationRevisionId: revisionId,
      candidateId: "11111111-1111-4111-8111-111111111111",
    }),
  ).toEqual({
    kind: "service.pull",
    serviceId: "data-manager",
    expectedConfigurationRevisionId: revisionId,
    candidateId: "11111111-1111-4111-8111-111111111111",
  });
  expect(
    opsOperationSchema.safeParse({
      kind: "service.pull",
      serviceId: "data-manager",
      expectedConfigurationRevisionId: revisionId,
      imageReference: "caller.invalid/image:latest",
    }).success,
  ).toBe(false);
});
it("requires actual bounded image and release evidence for a fresh pull result", () => {
  const result = {
    changed: true,
    revisionId,
    imageReference: "example/data-manager:2",
    imageId: `sha256:${"b".repeat(64)}`,
    releaseSelectionDigest: "c".repeat(64),
  };
  expect(() => parseOpsResult("service.pull", result)).not.toThrow();
  expect(() => parseOpsResult("service.pull", { changed: true })).toThrow();
  expect(() => parseOpsResult("service.pull", { ...result, imageId: "cached-latest" })).toThrow();
  expect(() =>
    parseOpsResult("service.pull", { ...result, imageReference: "a".repeat(2049) }),
  ).toThrow();
});
