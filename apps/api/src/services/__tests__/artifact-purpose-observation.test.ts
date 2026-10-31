import { expect, it } from "vitest";
import { purposeObservationSchema } from "../artifact-purpose-observation";

const digest = "a".repeat(64);
const observation = {
  kind: "artifactTransfer.validate",
  stageId: "3744615a-b76b-4b9f-b7e2-dd8624b8aa89",
  ownerId: "operator",
  sha256: digest,
  identity: {
    executionId: `job1_${"a".repeat(32)}`,
    operationKey: `opk1_${"b".repeat(32)}`,
    fingerprint: digest,
    executionDeadlineAt: "2026-10-30T12:00:00.000Z",
  },
  stage: {
    stageId: "3744615a-b76b-4b9f-b7e2-dd8624b8aa89",
    purpose: "prepared-artifact",
    direction: "upload",
    state: "ready",
    bytes: 128,
    sha256: digest,
    expiresAt: "2026-10-30T12:00:00.000Z",
    cleanup: "pending",
  },
};

it("retains only a matching final private validation observation before receipt delivery", () => {
  expect(purposeObservationSchema.safeParse(observation).success).toBe(true);
  for (const patch of [
    { state: "validating" },
    { state: "failed", cleanup: "pending" },
    { state: "ready", cleanup: "complete" },
    { sha256: "b".repeat(64) },
    { stageId: "38c23615-1e6e-4278-95f0-180185c8a81c" },
    { purpose: "instance-migration" },
    { direction: "download" },
  ])
    expect(
      purposeObservationSchema.safeParse({
        ...observation,
        stage: { ...observation.stage, ...patch },
      }).success,
    ).toBe(false);
  expect(
    purposeObservationSchema.safeParse({
      ...observation,
      stage: { ...observation.stage, state: "failed", cleanup: "complete" },
    }).success,
  ).toBe(true);
});
