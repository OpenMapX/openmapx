import { describe, expect, it } from "vitest";
import { snapshotContributors } from "./contributors.js";
import type { LicenseBinding } from "./licensing.js";
import * as metadata from "./licensing.js";

const policy = {
  placement: "visible",
  surfaces: ["map", "content"],
  basis: "provider-terms",
  reviewedAt: "2026-10-14",
  evidenceUrls: ["https://provider.example/terms"],
  reason: "Provider requires an adjacent linked notice",
  prominence: "normal",
  compactText: '<a href="https://provider.example/">Provider</a>',
} as const;
const binding: LicenseBinding = {
  scope: "data",
  subject: "Dataset",
  license: { kind: "spdx", expression: "CC-BY-4.0" },
};

describe("captured attribution placement", () => {
  it("accepts, copies and retains reviewed provider policy through contributor snapshots", () => {
    const value = { version: 1, bindings: [{ ...binding, attribution: policy }] };
    const parsed = metadata.parseLicensing(value);
    expect(parsed).toEqual(value);
    expect(parsed?.bindings[0].attribution).not.toBe(policy);
    expect(parsed?.bindings[0].attribution?.surfaces).not.toBe(policy.surfaces);
    const receipts = snapshotContributors([
      { sourceId: "dataset", name: "Dataset", licensing: parsed },
    ]);
    expect(receipts[0].licensing?.bindings[0].attribution).toEqual(policy);
  });
  it.each([
    { ...policy, placement: "details", basis: "unresolved", compactText: undefined },
    { ...policy, basis: "unresolved" },
    { ...policy, surfaces: [] },
    { ...policy, surfaces: ["map", "map"] },
    { ...policy, evidenceUrls: ["https://provider.example/terms?token=private"] },
    { ...policy, reviewedAt: "2026-02-30" },
    { ...policy, placement: "details" },
    { ...policy, arbitraryCode: "run()" },
  ])("rejects malformed/unsafe placement as a whole", (attribution) => {
    expect(
      metadata.parseLicensing({ version: 1, bindings: [{ ...binding, attribution }] }),
    ).toBeUndefined();
  });
});
