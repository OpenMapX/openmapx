import { describe, expect, it } from "vitest";
import { attentionHref } from "./attentionHref";

describe("attentionHref", () => {
  it("links a stored item to its admin action and nothing else", () => {
    const stored = { type: "stored", severity: "error", message: "m" } as const;
    expect(attentionHref({ ...stored, target: "/admin/extensions/demo" })).toBe(
      "/admin/extensions/demo",
    );
    expect(attentionHref({ ...stored, target: "https://example.org/" })).toBe("/admin");
    expect(attentionHref(stored)).toBe("/admin");
    expect(
      attentionHref({ type: "job_failed", severity: "error", message: "m", target: "job-1" }),
    ).toBe("/admin/activity");
    expect(attentionHref({ type: "service_unhealthy", severity: "error", message: "m" })).toBe(
      "/admin/system/services",
    );
  });
});
