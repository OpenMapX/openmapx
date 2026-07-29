import { describe, expect, it } from "vitest";
import {
  formatStageError,
  JOB_STATUS_COLOR,
  jobStatusColor,
  jobStatusDescription,
} from "../jobStatus";

describe("jobStatusColor", () => {
  it("maps each known status to its color", () => {
    expect(jobStatusColor("queued")).toBe("default");
    expect(jobStatusColor("running")).toBe("primary");
    expect(jobStatusColor("success")).toBe("success");
    expect(jobStatusColor("ok")).toBe("success");
    expect(jobStatusColor("failed")).toBe("error");
    expect(jobStatusColor("error")).toBe("error");
    expect(jobStatusColor("canceled")).toBe("warning");
    expect(jobStatusColor("partial")).toBe("warning");
    expect(jobStatusColor("stale")).toBe("warning");
    expect(jobStatusColor("interrupted")).toBe("warning");
    expect(jobStatusColor("skipped")).toBe("default");
  });

  it("falls back to default for an unknown status", () => {
    expect(jobStatusColor("nonsense")).toBe("default");
    expect(jobStatusColor("")).toBe("default");
  });

  it("exposes the underlying color map", () => {
    expect(JOB_STATUS_COLOR.success).toBe("success");
    expect(Object.keys(JOB_STATUS_COLOR)).toContain("running");
  });
});

describe("jobStatusDescription", () => {
  it("explains partial as a completed job with warnings", () => {
    expect(jobStatusDescription("partial")).toContain("Completed with warnings");
    expect(jobStatusDescription("partial")).toContain("partially succeeded");
  });

  it("omits a tooltip for an unknown status", () => {
    expect(jobStatusDescription("custom-status")).toBeNull();
  });
});

describe("formatStageError", () => {
  it("returns null for empty values so the UI renders nothing", () => {
    expect(formatStageError(null)).toBeNull();
    expect(formatStageError(undefined)).toBeNull();
    expect(formatStageError("")).toBeNull();
    expect(formatStageError("   ")).toBeNull();
  });

  it("passes a plain string through", () => {
    expect(formatStageError("boom")).toBe("boom");
  });

  it("prefers the concise message over the full stack for a structured error", () => {
    // This is the exact shape the data-manager stages persist into the jsonb
    // `error` column: { message, stack }. Rendering the object directly as a
    // React child throws "Objects are not valid as a React child" and crashes
    // the job-detail drawer — this helper exists to prevent that.
    const stored = {
      message: "Command failed with exit code 1: python3 ./src/generate-motis-config.py",
      stack: "ExecaError: Command failed with exit code 1\n  at ...",
    };
    expect(formatStageError(stored)).toBe(stored.message);
  });

  it("falls back to the stack when there is no message", () => {
    expect(formatStageError({ stack: "ExecaError: nope" })).toBe("ExecaError: nope");
  });

  it("JSON-stringifies an object that has neither message nor stack", () => {
    expect(formatStageError({ code: 1, detail: "x" })).toBe('{"code":1,"detail":"x"}');
  });
});
