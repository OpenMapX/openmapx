import { describe, expect, it } from "vitest";
import {
  type ExtensionManifest,
  extensionComponentSummary,
  validateExtensionManifest,
  verifiedCatalogEntrySchema,
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

  it("accepts a digest-pinned single-integration bundle", () => {
    const r = validateExtensionManifest({
      id: "weather-foo",
      name: "Weather Foo",
      version: "0.1.0",
      integrations: [
        { artifact: "https://example.com/foo.tar.gz", id: "weather-foo", sha256: "b".repeat(64) },
      ],
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
      integrations: [
        { artifact: "http://insecure.example/foo.tar.gz", id: "x", sha256: "b".repeat(64) },
      ],
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

  it("rejects an unpinned integration artifact", () => {
    const r = validateExtensionManifest({
      ...bundle,
      integrations: [{ artifact: "https://example.com/x.tar.gz", id: "x" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((error) => error.includes("sha256"))).toBe(true);
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

describe("manifest component identity", () => {
  it("rejects duplicate component ids within a manifest", () => {
    const r = validateExtensionManifest({
      ...bundle,
      integrations: [
        { artifact: "https://example.test/a.tar.gz", sha256: "a".repeat(64), id: "dup" },
        { artifact: "https://example.test/b.tar.gz", sha256: "b".repeat(64), id: "dup" },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unique/i);
  });

  it("rejects a service and an integration sharing one component id", () => {
    const r = validateExtensionManifest({
      ...bundle,
      services: [{ repo: "https://example.test/r.git", service: "shared" }],
      integrations: [
        { artifact: "https://example.test/a.tar.gz", sha256: "a".repeat(64), id: "shared" },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unique/i);
  });

  it("rejects a config target that names an undeclared component", () => {
    const r = validateExtensionManifest({
      ...bundle,
      config: [{ key: "TOKEN", target: "integration:not-declared" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/declared component/i);
  });

  it("rejects a readiness requirement that names an undeclared component", () => {
    const r = validateExtensionManifest({
      ...bundle,
      readiness: { requires: ["service:not-declared"] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/declared component/i);
  });

  it("rejects an integrationHealth that names an undeclared integration", () => {
    const r = validateExtensionManifest({
      ...bundle,
      readiness: { integrationHealth: "not-declared" },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/declared component/i);
  });

  it("rejects unknown top-level fields", () => {
    const r = validateExtensionManifest({ ...bundle, surprise: "value" });
    expect(r.valid).toBe(false);
  });
});

describe("verifiedCatalogEntrySchema", () => {
  const entry = {
    id: "openconditions-road-conditions",
    version: "1.0.0",
    manifest: "https://example.test/extension.json",
    manifestSha256: "c".repeat(64),
    platform: "1.0",
  };

  it("accepts a digest-pinned entry", () => {
    expect(verifiedCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("requires a manifest digest", () => {
    const { manifestSha256, ...withoutDigest } = entry;
    expect(verifiedCatalogEntrySchema.safeParse(withoutDigest).success).toBe(false);
  });

  it("rejects a malformed digest", () => {
    expect(
      verifiedCatalogEntrySchema.safeParse({ ...entry, manifestSha256: "not-a-digest" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields so a feed cannot smuggle trust inputs", () => {
    expect(verifiedCatalogEntrySchema.safeParse({ ...entry, trust: "verified" }).success).toBe(
      false,
    );
  });

  it("rejects a non-https manifest url", () => {
    expect(
      verifiedCatalogEntrySchema.safeParse({ ...entry, manifest: "http://example.test/e.json" })
        .success,
    ).toBe(false);
  });
});
