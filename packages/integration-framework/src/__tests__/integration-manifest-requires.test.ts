import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";

const valid = {
  id: "routing-valhalla",
  name: "Valhalla Routing",
  domains: ["routing"],
  healthCheck: { type: "http", url: "http://valhalla:8002/status" },
};

const validateBuiltIn = (raw: unknown) => validateManifest(raw, { firstParty: true });

describe("integration manifest.requires", () => {
  it("accepts a requires: [service] entry", () => {
    const r = validateBuiltIn({
      ...valid,
      requires: [{ service: "valhalla", optional: true }],
    });
    expect(r.valid).toBe(true);
  });

  it("accepts a requires: [capability] entry", () => {
    const r = validateBuiltIn({
      ...valid,
      requires: [{ capability: "routing-engine", optional: false }],
    });
    expect(r.valid).toBe(true);
  });

  it("accepts a Git URL as a service identifier", () => {
    const r = validateBuiltIn({
      ...valid,
      requires: [{ service: "https://github.com/someone/openmapx-service-foo" }],
    });
    expect(r.valid).toBe(true);
  });

  it("rejects entry missing both service and capability", () => {
    const r = validateBuiltIn({
      ...valid,
      requires: [{ optional: true }],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects entry with both service and capability", () => {
    const r = validateBuiltIn({
      ...valid,
      requires: [{ service: "x", capability: "y" }],
    });
    expect(r.valid).toBe(false);
  });

  it("accepts a manifest without requires", () => {
    const r = validateBuiltIn(valid);
    expect(r.valid).toBe(true);
  });
});

describe("integration background health cadence", () => {
  it("accepts slower probes and rejects intervals below the scheduler cadence", () => {
    expect(validateBuiltIn({ ...valid, healthCheckIntervalMs: 900_000 }).valid).toBe(true);
    for (const healthCheckIntervalMs of [0, -1, 59_999, 60_000.5, "900000"]) {
      expect(validateBuiltIn({ ...valid, healthCheckIntervalMs }).valid).toBe(false);
    }
  });
});
