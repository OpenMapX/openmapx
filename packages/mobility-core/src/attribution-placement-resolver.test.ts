import { describe, expect, it } from "vitest";
import { resolveBindingPlacement } from "./attribution-placement.js";
import type { LicenseBinding } from "./licensing.js";

const bind = (expression: string, scope: LicenseBinding["scope"] = "data"): LicenseBinding => ({
  scope,
  subject: "Dataset",
  license: { kind: "spdx", expression },
});
describe("reviewed placement defaults", () => {
  it.each([
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
    "DL-DE-BY-2.0",
    "NLOD-2.0",
    "CC0-1.0",
    "DL-DE-ZERO-2.0",
    "PDDL-1.0",
    "OGL-UK-3.0",
    "OGL-Canada-2.0",
    "etalab-2.0",
    "CDLA-Permissive-2.0",
    "Apache-2.0",
  ])("permits complete direct details for %s", (id) => {
    expect(resolveBindingPlacement(bind(id), "map").placement).toBe("details");
  });
  it.each([
    "ODbL-1.0",
    "CC-BY-3.0",
    "CC-BY-SA-3.0-DE",
    "CC-BY-4.0 OR ODbL-1.0",
    "CC-BY-4.0 AND ODbL-1.0",
    "Apache-2.0 WITH LLVM-exception",
  ])("keeps every unreviewed alternative/exception visible for %s", (id) => {
    expect(resolveBindingPlacement(bind(id), "map").placement).toBe("visible");
  });
  it("never transfers engine permission to content and does not select OR branches", () => {
    expect(resolveBindingPlacement(bind("MIT", "software"), "map").placement).toBe("details");
    expect(
      resolveBindingPlacement(
        { scope: "data", subject: "Output", license: { kind: "unknown" } },
        "map",
      ).placement,
    ).toBe("visible");
    expect(resolveBindingPlacement(bind("CC-BY-4.0 OR NLOD-2.0"), "content").placement).toBe(
      "details",
    );
  });
  it("lets captured provider requirements override CC4 only on their reviewed surfaces", () => {
    const binding: LicenseBinding = {
      ...bind("CC-BY-4.0"),
      attribution: {
        placement: "visible",
        surfaces: ["map", "content"],
        basis: "provider-terms",
        reviewedAt: "2026-10-14",
        evidenceUrls: ["https://provider.test/terms"],
        reason: "Visible link required",
        compactText: '<a href="https://provider.test/">Provider</a>',
      },
    };
    expect(resolveBindingPlacement(binding, "map")).toMatchObject({
      placement: "visible",
      basis: "provider-terms",
      compactText: binding.attribution?.compactText,
    });
    expect(resolveBindingPlacement(binding, "image").placement).toBe("details");
  });
});
