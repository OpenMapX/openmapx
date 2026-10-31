import { randomUUID } from "node:crypto";
import { opsExecutionBudget } from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { prepareApiJobRoot } from "../admin-job-parent";
import type { JobContext } from "../job-runner";

it("freezes a bounded whole-extension parent lifetime while retaining the shorter individual child deadline", () => {
  const ctx: JobContext = {
    jobId: randomUUID(),
    jobType: "extension.install",
    execution: { owner: randomUUID(), version: 1 },
    payload: {
      manifest: {
        services: [{ service: "one", repo: "https://github.com/example/one" }],
        integrations: [],
      },
    },
    signal: new AbortController().signal,
    checkpoint: async () => {},
    log: async () => {},
    setProgress: async () => {},
  };
  const before = Date.now();
  const root = prepareApiJobRoot(ctx, "serviceRepository.publish", "fixed-step");
  expect(root.parent.deadlineAt - before).toBeGreaterThan(
    opsExecutionBudget("serviceRepository.publish").processMs +
      opsExecutionBudget("service.pull").processMs,
  );
  expect(root.requestedDeadlineAt - before).toBeLessThanOrEqual(
    opsExecutionBudget("serviceRepository.publish").processMs + 100,
  );
  ctx.checkpointResult = { _parentExecution: root.parent };
  expect(prepareApiJobRoot(ctx, "service.start", "next-step").parent).toEqual(root.parent);
});
