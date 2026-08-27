import { describe, expect, it } from "vitest";
import {
  OPS_MAX_HTTP_RESPONSE_BYTES,
  OPS_MAX_RESULT_BYTES,
  parseOpsEventBatch,
  parseOpsJobStatusForKind,
  parseOpsResult,
} from "./contract";

describe("second reviewed ops protocol", () => {
  it("accepts safe slash region IDs in results and retained statuses", () => {
    expect(
      parseOpsResult("data.overtureSync", {
        completed: true,
        resourceId: "europe/germany",
      }),
    ).toEqual({ completed: true, resourceId: "europe/germany" });
    expect(
      parseOpsJobStatusForKind("data.overtureSync", {
        version: 1,
        operationId: "job1_regionOperation00",
        operationKey: "opk1_regionOperation00",
        kind: "data.overtureSync",
        resourceId: "europe/germany",
        state: "succeeded",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
        result: { completed: true, resourceId: "europe/germany" },
      }),
    ).toMatchObject({ resourceId: "europe/germany" });
    for (const invalid of [
      "/europe/germany",
      "europe/../germany",
      "europe/./germany",
      "europe//germany",
      "../germany",
    ]) {
      expect(() =>
        parseOpsResult("data.overtureSync", { completed: true, resourceId: invalid }),
      ).toThrow();
    }
  });

  it("reserves strict envelope overhead above the largest valid result", () => {
    expect(OPS_MAX_HTTP_RESPONSE_BYTES).toBeGreaterThan(OPS_MAX_RESULT_BYTES);
    expect(OPS_MAX_HTTP_RESPONSE_BYTES - OPS_MAX_RESULT_BYTES).toBeGreaterThanOrEqual(8 * 1024);
  });

  it("binds status IDs and event cursor pages to the exact client request", () => {
    const status = {
      version: 1,
      operationId: "job1_exactOperation000",
      operationKey: "opk1_exactOperation000",
      kind: "service.pull",
      resourceId: "redis",
      state: "running",
      submittedAt: "2026-08-23T18:00:00.000Z",
      updatedAt: "2026-08-23T18:00:01.000Z",
    };
    expect(() =>
      parseOpsJobStatusForKind("service.pull", status, {
        operationId: "job1_otherOperation000",
      }),
    ).toThrow();

    const page = {
      version: 1,
      operationId: "job1_exactOperation000",
      nextCursor: 4,
      terminal: false,
      truncated: false,
      events: [
        { cursor: 3, type: "state", state: "running" },
        { cursor: 4, type: "log", stream: "stdout", message: "ok" },
      ],
    };
    expect(
      parseOpsEventBatch(page, { operationId: "job1_exactOperation000", after: 2 }),
    ).toMatchObject({ nextCursor: 4 });
    for (const invalid of [
      { ...page, operationId: "job1_otherOperation000" },
      { ...page, events: [page.events[1], page.events[0]] },
      { ...page, events: [{ ...page.events[0], cursor: 2 }] },
      { ...page, nextCursor: 5 },
    ]) {
      expect(() =>
        parseOpsEventBatch(invalid, { operationId: "job1_exactOperation000", after: 2 }),
      ).toThrow();
    }

    expect(() =>
      parseOpsEventBatch(
        { ...page, events: [page.events[1]], nextCursor: 4, truncated: false },
        { operationId: "job1_exactOperation000", after: 2 },
      ),
    ).toThrow();
    expect(() =>
      parseOpsEventBatch(
        {
          ...page,
          events: [
            { ...page.events[0], cursor: 4 },
            { ...page.events[1], cursor: 6 },
          ],
          nextCursor: 6,
          truncated: true,
        },
        { operationId: "job1_exactOperation000", after: 2 },
      ),
    ).toThrow();
    expect(
      parseOpsEventBatch(
        {
          ...page,
          events: [
            { ...page.events[0], cursor: 4 },
            { ...page.events[1], cursor: 5 },
          ],
          nextCursor: 5,
          truncated: true,
        },
        { operationId: "job1_exactOperation000", after: 2 },
      ),
    ).toMatchObject({ nextCursor: 5 });
  });
});
