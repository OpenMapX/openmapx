import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";

const valid = {
  id: "routing-valhalla",
  name: "Valhalla Routing",
  domains: ["routing"],
  healthCheck: { type: "http", url: "http://valhalla:8002/status" },
};

describe("integration manifest.requires", () => {
  it("accepts a requires: [service] entry", () => {
    const r = validateManifest({
      ...valid,
      requires: [{ service: "valhalla", optional: true }],
    });
    expect(r.valid).toBe(true);
  });

  it("accepts a requires: [capability] entry", () => {
    const r = validateManifest({
      ...valid,
      requires: [{ capability: "routing-engine", optional: false }],
    });
    expect(r.valid).toBe(true);
  });

  it("accepts a Git URL as a service identifier", () => {
    const r = validateManifest({
      ...valid,
      requires: [{ service: "https://github.com/someone/openmapx-service-foo" }],
    });
    expect(r.valid).toBe(true);
  });

  it("rejects entry missing both service and capability", () => {
    const r = validateManifest({
      ...valid,
      requires: [{ optional: true }],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects entry with both service and capability", () => {
    const r = validateManifest({
      ...valid,
      requires: [{ service: "x", capability: "y" }],
    });
    expect(r.valid).toBe(false);
  });

  it("still accepts manifest without requires (backwards-shape compatible)", () => {
    const r = validateManifest(valid);
    expect(r.valid).toBe(true);
  });
});
