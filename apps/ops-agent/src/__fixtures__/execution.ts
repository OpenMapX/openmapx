import type { ExecutionRef } from "@openmapx/core/ops";

/** Synthetic context for adapter tests; the real server supplies the retained admission. */
export function testExecution(): ExecutionRef {
  return { executor: "ops-agent", principal: "api", executionId: "job1_testabcdefghijkl", operationKey: "opk1_testabcdefghijkl", operationFingerprint: "a".repeat(64), fingerprint: "b".repeat(64), deadlineAt: Date.now() + 3600_000 };
}
