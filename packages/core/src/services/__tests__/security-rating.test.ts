import { describe, expect, it } from "vitest";
import { computeServiceSecurityRating } from "../security-rating";
import type { ServiceManifest } from "../types";

function svc(overrides: Partial<ServiceManifest>): ServiceManifest {
  return {
    id: "x",
    name: "X",
    version: "1.0.0",
    quality: "community",
    container: { image: "ghcr.io/x/y", tag: "1" },
    ...overrides,
  } as ServiceManifest;
}

describe("computeServiceSecurityRating", () => {
  it("rewards a contained service (no host ports, owns schema, auth)", () => {
    const r = computeServiceSecurityRating(
      svc({
        container: { image: "ghcr.io/x/y", tag: "1", expose: [8080] },
        ownsSchema: "conditions",
        exposure: { proxy: { enabled: true, authRequired: true } },
      }),
    );
    // base 5 +1 auth +1 no-host-ports +1 owns-schema = 8 (clamped max)
    expect(r.score).toBe(8);
    expect(r.requiresBuiltIn).toBe(false);
    expect(r.hostPorts).toBe(0);
  });

  it("penalizes published host ports", () => {
    const r = computeServiceSecurityRating(
      svc({ exposure: { hostPorts: [{ container: 80, host: 8080 }] } }),
    );
    // base 5 - 1 hostport = 4
    expect(r.score).toBe(4);
    expect(r.hostPorts).toBe(1);
  });

  it("flags built-in-only privileges and floors the score", () => {
    const r = computeServiceSecurityRating(
      svc({
        quality: "built-in",
        container: { image: "ghcr.io/x/y", tag: "1", privileged: true, networkMode: "host" },
      }),
    );
    expect(r.requiresBuiltIn).toBe(true);
    // base 5 +1 no-host-ports -2 elevated = 4
    expect(r.score).toBe(4);
    expect(r.factors.some((f) => f.includes("elevated"))).toBe(true);
  });

  it("counts secret config fields", () => {
    const r = computeServiceSecurityRating(
      svc({
        configSchema: {
          properties: {
            API_KEY: { type: "string", "x-openmapx-secret": true },
            REGION: { type: "string" },
          },
        },
      }),
    );
    expect(r.secretCount).toBe(1);
  });

  it("never returns a score outside 1..8", () => {
    const r = computeServiceSecurityRating(
      svc({
        exposure: {
          hostPorts: [
            { container: 1, host: 1 },
            { container: 2, host: 2 },
            { container: 3, host: 3 },
            { container: 4, host: 4 },
            { container: 5, host: 5 },
            { container: 6, host: 6 },
            { container: 7, host: 7 },
            { container: 8, host: 8 },
          ],
        },
      }),
    );
    expect(r.score).toBe(1);
  });
});
