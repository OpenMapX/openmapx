import { describe, expect, it } from "vitest";
import {
  type ExtensionManifest,
  extensionComponentSummary,
  validateExtensionManifest,
} from "../extension-schema";

const bundle: ExtensionManifest = {
  id: "openconditions-road-conditions",
  name: "OpenConditions — Road Conditions",
  version: "1.0.0",
  platform: "1.0",
  services: [
    {
      repo: "https://github.com/openconditions/openconditions",
      ref: "v1.0.0",
      service: "openconditions-ingest",
    },
  ],
  integrations: [
    {
      artifact:
        "https://github.com/openconditions/openconditions/releases/download/v1.0.0/overlay-road-conditions.tar.gz",
      sha256: "a".repeat(64),
      id: "overlay-road-conditions",
    },
  ],
};

describe("validateExtensionManifest", () => {
  it("accepts a full multi-component bundle", () => {
    const r = validateExtensionManifest(bundle);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("accepts a degenerate single-integration bundle", () => {
    const r = validateExtensionManifest({
      id: "weather-foo",
      name: "Weather Foo",
      version: "0.1.0",
      integrations: [{ artifact: "https://example.com/foo.tar.gz", id: "weather-foo" }],
    });
    expect(r.valid).toBe(true);
  });

  it("accepts a degenerate single-service bundle", () => {
    const r = validateExtensionManifest({
      id: "engine-bar",
      name: "Engine Bar",
      version: "0.1.0",
      services: [{ repo: "https://github.com/x/y", service: "engine-bar" }],
    });
    expect(r.valid).toBe(true);
  });

  it("rejects a bundle with no components", () => {
    const r = validateExtensionManifest({ id: "empty", name: "Empty", version: "1.0.0" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("at least one"))).toBe(true);
  });

  it("rejects an invalid id", () => {
    const r = validateExtensionManifest({ ...bundle, id: "Bad Id" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects a non-https integration artifact url", () => {
    const r = validateExtensionManifest({
      ...bundle,
      integrations: [{ artifact: "http://insecure.example/foo.tar.gz", id: "x" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("https"))).toBe(true);
  });

  it("rejects a malformed sha256", () => {
    const r = validateExtensionManifest({
      ...bundle,
      integrations: [{ artifact: "https://example.com/x.tar.gz", id: "x", sha256: "nope" }],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects a config target that is neither service: nor integration:", () => {
    const r = validateExtensionManifest({
      ...bundle,
      config: [{ key: "K", target: "bogus:openconditions-ingest" }],
    });
    expect(r.valid).toBe(false);
  });

  it("accepts well-formed config + readiness blocks", () => {
    const r = validateExtensionManifest({
      ...bundle,
      config: [{ key: "NDW_ENABLED", target: "service:openconditions-ingest", default: "true" }],
      readiness: {
        requires: ["service:openconditions-ingest"],
        integrationHealth: "overlay-road-conditions",
      },
    });
    expect(r.valid).toBe(true);
  });
});

describe("extensionComponentSummary", () => {
  it("lists services and integrations with their kind + id", () => {
    expect(extensionComponentSummary(bundle)).toEqual([
      { kind: "service", id: "openconditions-ingest" },
      { kind: "integration", id: "overlay-road-conditions" },
    ]);
  });
});
