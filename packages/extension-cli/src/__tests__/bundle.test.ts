import { services } from "@openmapx/core/server";
import { describe, expect, it } from "vitest";
import { buildExtensionManifest } from "../commands/bundle.js";

describe("buildExtensionManifest", () => {
  it("assembles a service + integration bundle that passes the core validator", () => {
    const doc = buildExtensionManifest({
      id: "openconditions",
      name: "OpenConditions",
      version: "1.0.0",
      platform: "1.0",
      service: ["https://github.com/o/c,v1.0.0,oc-ingest"],
      integration: [`https://example.com/x.tar.gz,${"a".repeat(64)},overlay-x`],
    });
    expect(doc.services).toEqual([
      { repo: "https://github.com/o/c", ref: "v1.0.0", service: "oc-ingest" },
    ]);
    expect(doc.integrations?.[0]).toMatchObject({ id: "overlay-x" });
    // The emitted doc must satisfy the platform's extension.json schema.
    expect(services.validateExtensionManifest(doc).valid).toBe(true);
  });

  it("omits an empty ref", () => {
    const doc = buildExtensionManifest({
      id: "x",
      name: "X",
      version: "1.0.0",
      service: ["https://github.com/o/c,,svc"],
    });
    expect(doc.services?.[0]).toEqual({ repo: "https://github.com/o/c", service: "svc" });
  });

  it("rejects a bundle with no components", () => {
    expect(() => buildExtensionManifest({ id: "x", name: "X", version: "1.0.0" })).toThrow(
      /at least one/,
    );
  });

  it("rejects an invalid id", () => {
    expect(() =>
      buildExtensionManifest({
        id: "Bad Id",
        name: "X",
        version: "1.0.0",
        service: ["https://github.com/o/c,,svc"],
      }),
    ).toThrow(/Invalid id/);
  });

  it("rejects an integration artifact without a digest", () => {
    expect(() =>
      buildExtensionManifest({
        id: "x",
        name: "X",
        version: "1.0.0",
        integration: ["https://example.com/x.tar.gz,,x"],
      }),
    ).toThrow(/sha256/);
  });
});
