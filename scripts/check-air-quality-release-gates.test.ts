import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkAirQualityReleaseGates } from "./check-air-quality-release-gates.js";

function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-aq-gates-"));
  const statusDir = join(root, "docs/docs/administration/air-quality-status");
  const integrationDir = join(root, "integrations/example");
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(integrationDir, { recursive: true });
  writeFileSync(
    join(integrationDir, "manifest.json"),
    JSON.stringify({ dataSources: [{ sourceId: "official-source" }] }),
  );
  writeFileSync(
    join(integrationDir, "fixture.json"),
    JSON.stringify({
      transcriptionChecksum: `sha256:${"a".repeat(64)}`,
      independentDerivation: { reviewer: "fixture reviewer" },
    }),
  );
  const fields = {
    air_quality_component: "base",
    status: "shipped",
    code_path: "integrations/example",
    manifest_paths: "integrations/example/manifest.json",
    manifest_source_ids: "official-source",
    standard_revision: "example-v1",
    terms_record: "https://example.test/terms",
    fixture_metadata: "integrations/example/fixture.json",
    focused_test: "pnpm test -- example",
    live_smoke_date: "2026-08-30",
    legal_approval: "not-required",
    blocker: "none",
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  writeFileSync(join(statusDir, "base.md"), `---\n${frontmatter}\n---\n\n# Base\n`);
  writeFileSync(
    join(root, "docs/docs/administration/air-quality-release-status.md"),
    `---\ntitle: Status\n---\n\n| Component | Status | Record |\n| --- | --- | --- |\n| Base | shipped | [Base](./air-quality-status/base.md) |\n`,
  );
  return root;
}

describe("air-quality release gate checker", () => {
  it("accepts a truthful shipped record", () => {
    expect(checkAirQualityReleaseGates(fixture())).toEqual([]);
  });

  it("rejects missing manifests and unknown source IDs", () => {
    const errors = checkAirQualityReleaseGates(
      fixture({
        manifest_paths: "integrations/example/missing.json",
        manifest_source_ids: "invented-source",
      }),
    );
    expect(errors.join("\n")).toContain("manifest does not exist");
    expect(errors.join("\n")).toContain("unknown manifest source ID");
  });

  it("rejects fixture metadata without a checksum or reviewer", () => {
    const root = fixture();
    writeFileSync(join(root, "integrations/example/fixture.json"), JSON.stringify({}));
    const errors = checkAirQualityReleaseGates(root).join("\n");
    expect(errors).toContain("snapshot checksum");
    expect(errors).toContain("reviewer");
  });

  it("rejects an absent legal decision and stale contract review", () => {
    const errors = checkAirQualityReleaseGates(
      fixture({ legal_approval: "", live_smoke_date: "2025-01-01" }),
      new Date("2026-08-30T00:00:00Z"),
    ).join("\n");
    expect(errors).toContain("legal_approval");
    expect(errors).toContain("contract review is stale");
  });

  it("rejects a matrix claim whose code path does not exist", () => {
    const errors = checkAirQualityReleaseGates(
      fixture({ code_path: "integrations/nonexistent" }),
    ).join("\n");
    expect(errors).toContain("code path does not exist");
  });

  it("accepts an explicit blocked record with no provider code", () => {
    const root = fixture({
      status: "blocked",
      code_path: "none",
      manifest_paths: "none",
      manifest_source_ids: "none",
      fixture_metadata: "none",
      focused_test: "not-run-stop-gate",
      legal_approval: "missing",
      blocker: "The mandatory dataset-specific approval is absent.",
    });
    const matrix = join(root, "docs/docs/administration/air-quality-release-status.md");
    writeFileSync(
      matrix,
      `---\ntitle: Status\n---\n\n| Component | Status | Record |\n| --- | --- | --- |\n| Base | blocked | [Base](./air-quality-status/base.md) |\n`,
    );
    expect(checkAirQualityReleaseGates(root)).toEqual([]);
  });
});
