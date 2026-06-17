import { describe, expect, it } from "vitest";
import { JOB_STATUS_COLOR, jobStatusColor } from "../jobStatus";

describe("jobStatusColor", () => {
  it("maps each known status to its color", () => {
    expect(jobStatusColor("queued")).toBe("default");
    expect(jobStatusColor("running")).toBe("primary");
    expect(jobStatusColor("success")).toBe("success");
    expect(jobStatusColor("failed")).toBe("error");
    expect(jobStatusColor("error")).toBe("error");
    expect(jobStatusColor("canceled")).toBe("warning");
    expect(jobStatusColor("partial")).toBe("warning");
    expect(jobStatusColor("stale")).toBe("warning");
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
