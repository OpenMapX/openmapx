import { randomUUID } from "node:crypto";
import type { ExecutionRef } from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { reserveTransitChildOperations } from "./ops-children";

const execution: ExecutionRef = {
  executor: "data-manager",
  principal: "api",
  executionId: randomUUID(),
  operationKey: "opk1_catalogReservedRoot0001",
  operationFingerprint: "a".repeat(64),
  fingerprint: "b".repeat(64),
  deadlineAt: Date.now() + 3600000,
};
const proposalId = randomUUID(),
  validationId = randomUUID();
it("freezes validation's two distinct stops, staging restart and proxy restoration only", () => {
  const slots = reserveTransitChildOperations(execution, {
    kind: "catalog.validate",
    proposalId,
    countries: ["de"],
  });
  expect(slots.map((slot) => [slot.phase, slot.ordinal])).toEqual([
    ["stop-staging", 0],
    ["restart-staging", 1],
    ["proxy-stage", 2],
    ["proxy-restore", 3],
    ["stop-staging", 4],
  ]);
  expect(new Set(slots.map((slot) => slot.operationKey)).size).toBe(5);
  expect(
    slots.some((slot) => slot.phase === "promote-primary" || slot.phase === "paired-pin-commit"),
  ).toBe(false);
});
it("freezes exact validation promotion and paired commit ordinal zero under one activation root", () => {
  const slots = reserveTransitChildOperations(execution, {
    kind: "catalog.activate",
    proposalId,
    validationId,
    expectedGenerationId: null,
    diffDigest: "c".repeat(64),
    acknowledgeLicenseChanges: true,
  });
  expect(slots[0]).toMatchObject({
    phase: "paired-pin-commit",
    ordinal: 0,
    serviceIds: ["motis"],
    operation: {
      kind: "transitousLock.approve",
      proposalId,
      validationId,
      expectedGenerationId: null,
      diffDigest: "c".repeat(64),
      acknowledgeLicenseChanges: true,
    },
  });
  expect(slots.find((slot) => slot.phase === "promote-primary")?.operation).toEqual({
    kind: "motis.primary.promote",
    preparedRunId: validationId,
  });
  expect(new Set(slots.map((slot) => slot.ordinal)).size).toBe(slots.length);
});
