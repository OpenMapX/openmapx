import type { AdminPlatformPreview } from "@openmapx/core/api-contracts";
import { expect, it } from "vitest";
import { buildPlatformCandidate, platformPreviewWithinScope } from "./platformScope";

const baseline = {
  configuration: { version: 1, domain: { source: "database", value: "maps.example.test" } },
  values: {
    domain: "maps.example.test",
    acmeEmail: "admin@example.test",
    releaseSelector: "main",
    defaultRegion: null,
    backupRetentionDays: 30,
  },
  sources: {
    domain: "database",
    acmeEmail: "host",
    releaseSelector: "host",
    defaultRegion: "host",
    backupRetentionDays: "host",
  },
} as const;
const candidate = buildPlatformCandidate(
  baseline.configuration,
  {
    backupRetentionDays: { source: "database", value: 60 },
    domain: { source: "database", value: "evil.test" },
  },
  "retention",
);
const preview = {
  ...baseline,
  configuration: candidate,
  values: { ...baseline.values, backupRetentionDays: 60 },
  sources: { ...baseline.sources, backupRetentionDays: "database" },
  oldOrigin: "https://maps.example.test",
  newOrigin: "https://maps.example.test",
} as AdminPlatformPreview;
it("overlays only a scope's edited keys onto the freshly captured full configuration", () => {
  expect(candidate).toEqual({
    ...baseline.configuration,
    backupRetentionDays: { source: "database", value: 60 },
  });
  expect(Object.hasOwn(candidate, "defaultRegion")).toBe(false);
  expect(platformPreviewWithinScope(preview, baseline, candidate, "retention")).toBe(true);
});
it.each(["configuration", "values", "sources"] as const)(
  "refuses hidden-field changes in %s",
  (part) => {
    const changed = structuredClone(preview);
    if (part === "configuration") changed.configuration.domain = { source: "host" };
    if (part === "values") changed.values.domain = "other.example.test";
    if (part === "sources") changed.sources.domain = "host";
    expect(platformPreviewWithinScope(changed, baseline, candidate, "retention")).toBe(false);
  },
);
it("refuses an unrelated origin change or release selection in retention", () => {
  expect(
    platformPreviewWithinScope(
      { ...preview, newOrigin: "https://other.test" },
      baseline,
      candidate,
      "retention",
    ),
  ).toBe(false);
  expect(
    platformPreviewWithinScope(
      { ...preview, release: {} } as AdminPlatformPreview,
      baseline,
      candidate,
      "retention",
    ),
  ).toBe(false);
});
it("keeps omitted fields omitted and supports explicitly returning only retention to the host", () => {
  expect(
    buildPlatformCandidate(
      { ...candidate, defaultRegion: { source: "database", value: "europe/germany" } },
      { backupRetentionDays: { source: "host" } },
      "retention",
    ),
  ).toEqual({
    ...baseline.configuration,
    defaultRegion: { source: "database", value: "europe/germany" },
    backupRetentionDays: { source: "host" },
  });
});
