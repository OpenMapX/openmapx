import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAuditActionLabel } from "../auditActionLabel";
import { useConfigSourceLabel } from "../configSourceLabel";
import { useJobStageLabel } from "../jobStageLabel";
import { useJobTypeLabel } from "../jobTypeLabel";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

const label = <T,>(hook: () => T) => renderHook(hook).result.current;

describe("server code labels", () => {
  it("word known job types, including data-manager kinds", () => {
    const jobType = label(useJobTypeLabel);
    expect(jobType("service.core-restart")).toBe("Restart core service");
    expect(jobType("transit-sync")).toBe("Sync transit");
  });

  it("show an unknown job type as its code with readable separators", () => {
    expect(label(useJobTypeLabel)("search-index.rebuild:all")).toBe("search index › rebuild › all");
  });

  it("word known audit actions and show an unknown one as its code", () => {
    const action = label(useAuditActionLabel);
    expect(action("data.overture-pull")).toBe("Overture data downloaded");
    expect(action("future.action-code")).toBe("future.action-code");
  });

  it("word known stages and show an unknown one as its code", () => {
    const stage = label(useJobStageLabel);
    expect(stage("gen-motis-config")).toBe("Generate MOTIS configuration");
    expect(stage("future-stage")).toBe("future-stage");
  });

  it("word known configuration sources and show an unknown one as its code", () => {
    const source = label(useConfigSourceLabel);
    expect(source("config.json")).toBe("config.json");
    expect(source("env")).toBe("environment");
    expect(source("keychain")).toBe("keychain");
  });
});
