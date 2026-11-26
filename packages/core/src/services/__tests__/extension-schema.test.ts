import { describe, expect, it } from "vitest";
import {
  canonicalExtensionLocator,
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
      platform: "1.0",
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
      platform: "1.0",
      services: [{ repo: "https://github.com/x/y", service: "engine-bar" }],
    });
    expect(r.valid).toBe(true);
  });

  it("rejects a bundle with no components", () => {
    const r = validateExtensionManifest({
      id: "empty",
      name: "Empty",
      version: "1.0.0",
      platform: "1.0",
    });
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

  it.each([
    "https://user@example.test/foo.tar.gz",
    "https://user:password@example.test/foo.tar.gz",
    "https://example.test/foo.tar.gz?token=secret",
    "https://example.test/foo.tar.gz#secret",
  ])("rejects a non-portable integration artifact locator: %s", (artifact) => {
    const r = validateExtensionManifest({
      ...bundle,
      integrations: [{ artifact, id: "x", sha256: "b".repeat(64) }],
    });
    expect(r.valid).toBe(false);
  });

  it.each([
    "http://example.test/repo.git",
    "https://user@example.test/repo.git",
    "https://user:password@example.test/repo.git",
    "https://example.test/repo.git?token=secret",
    "https://example.test/repo.git#secret",
  ])("rejects a non-portable service repository locator: %s", (repo) => {
    const r = validateExtensionManifest({
      ...bundle,
      services: [{ repo, service: "x" }],
      integrations: undefined,
    });
    expect(r.valid).toBe(false);
  });

  it("canonicalizes accepted component locators", () => {
    expect(canonicalExtensionLocator("https://EXAMPLE.test:443/releases/../repo.git")).toBe(
      "https://example.test/repo.git",
    );
    expect(canonicalExtensionLocator("https://EXAMPLE.test:443/releases/../artifact.tar.gz")).toBe(
      "https://example.test/artifact.tar.gz",
    );
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
});

describe("extension config, optional services and changelog", () => {
  const bundle = {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    platform: "1.0",
    services: [
      { repo: "https://github.com/example/demo", ref: "a".repeat(40), service: "demo-engine" },
    ],
    integrations: [
      { artifact: "https://example.org/demo.tar.gz", sha256: "b".repeat(64), id: "demo-adapter" },
    ],
  };
  const toEngine = (key: string) => ({ component: "service:demo-engine", key });
  it("accepts shared, secret, generated and capability-bound config with a changelog", () => {
    expect(
      validateExtensionManifest({
        ...bundle,
        webPlatform: "1.0",
        changelog: "https://example.org/releases?tag=v1.0.0#notes",
        services: [
          ...bundle.services,
          {
            repo: "https://github.com/example/demo",
            ref: "a".repeat(40),
            service: "demo-heavy",
            optional: true,
          },
        ],
        config: [
          {
            key: "relayToken",
            secret: true,
            generated: true,
            targets: [
              toEngine("RELAY_TOKEN"),
              { component: "integration:demo-adapter", key: "relayToken" },
              { capability: "acme/feed" },
            ],
          },
          {
            key: "instanceId",
            targets: [
              toEngine("INSTANCE_ID"),
              { component: "service:demo-heavy", key: "INSTANCE_ID" },
            ],
          },
          {
            key: "mode",
            default: "fixture",
            targets: [{ component: "integration:demo-adapter", key: "mode" }],
          },
        ],
      }),
    ).toEqual({ valid: true, errors: [] });
  });
  it.each([
    [{ readiness: { requires: ["service:demo-engine"] } }, "readiness"],
    [{ config: [{ key: "k", target: "service:demo-engine" }] }, "target"],
    [
      { config: [{ key: "RELAY_TOKEN", targets: [toEngine("K")] }] },
      "extension config keys must be lowerCamel",
    ],
    [{ config: [{ key: "k".repeat(65), targets: [toEngine("K")] }] }, "config"],
    [{ config: [{ key: "k", targets: [] }] }, "targets"],
    [
      { config: [{ key: "k", targets: [{ component: "service:other", key: "K" }] }] },
      "config must reference a declared component",
    ],
    [
      { config: [{ key: "k", targets: [toEngine("relayToken")] }] },
      "config target keys follow their component's key style",
    ],
    [
      {
        config: [
          { key: "k", targets: [{ component: "integration:demo-adapter", key: "RELAY_TOKEN" }] },
        ],
      },
      "config target keys follow their component's key style",
    ],
    [
      {
        config: [
          { key: "a", targets: [toEngine("K")] },
          { key: "b", targets: [toEngine("K")] },
        ],
      },
      "a component setting may receive one config value",
    ],
    [
      {
        config: [
          { key: "a", targets: [toEngine("K")] },
          { key: "a", targets: [toEngine("L")] },
        ],
      },
      "config keys must be unique",
    ],
    [
      { config: [{ key: "k", secret: true, targets: [{ capability: "feed" }] }] },
      "config capability targets name a well-known or <vendor>/<name> capability",
    ],
    [
      {
        config: [{ key: "k", secret: true, targets: [{ capability: "acme/feed", key: "token" }] }],
      },
      "targets",
    ],
    [
      {
        config: [
          {
            key: "k",
            secret: true,
            targets: [{ component: "capability:acme/feed", key: "token" }],
          },
        ],
      },
      "config",
    ],
    [
      { config: [{ key: "k", targets: [{ capability: "acme/feed" }] }] },
      "a config value delivered to a capability is a secret",
    ],
    [
      {
        config: [
          { key: "a", secret: true, targets: [{ capability: "acme/feed" }] },
          { key: "b", secret: true, targets: [{ capability: "acme/feed" }] },
        ],
      },
      "a capability may receive one config value",
    ],
    [
      { config: [{ key: "k", generated: true, targets: [toEngine("K")] }] },
      "a generated config value is a secret",
    ],
    [
      { config: [{ key: "k", secret: true, default: "x", targets: [toEngine("K")] }] },
      "a secret config value has no default",
    ],
    [{ changelog: "http://example.org/changes" }, "must be an https URL without credentials"],
    [
      { changelog: "https://user:pw@example.org/changes" },
      "must be an https URL without credentials",
    ],
    [
      { integrations: undefined, services: [{ ...bundle.services[0], optional: true }] },
      "an extension must declare at least one component that is not an optional service",
    ],
  ])("refuses %j", (fields, message) => {
    const result = validateExtensionManifest({ ...bundle, ...fields });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(message);
  });
  it("lets a verified catalogue entry mark a pre-release and link a changelog", () => {
    const entry = {
      id: "demo",
      version: "1.1.0-rc.1",
      manifest: "https://example.org/extension.json",
      manifestSha256: "c".repeat(64),
      platform: "1.0",
      webPlatform: "1.0",
      prerelease: true,
      changelog: "https://example.org/releases#v1.1.0-rc.1",
    };
    expect(verifiedCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(verifiedCatalogEntrySchema.safeParse({ ...entry, prerelease: "yes" }).success).toBe(
      false,
    );
    expect(
      verifiedCatalogEntrySchema.safeParse({ ...entry, changelog: "http://example.org" }).success,
    ).toBe(false);
    expect(verifiedCatalogEntrySchema.safeParse({ ...entry, trusted: true }).success).toBe(false);
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

  it.each([
    "https://example.test/extension.json",
    "https://EXAMPLE.test:443/releases/../extension.json",
  ])("accepts a digest-pinned HTTPS locator: %s", (manifest) => {
    expect(verifiedCatalogEntrySchema.safeParse({ ...entry, manifest }).success).toBe(true);
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

  it.each([
    "https://user@example.test/extension.json",
    "https://user:password@example.test/extension.json",
    "https://example.test/extension.json?token=secret",
    "https://example.test/extension.json#secret",
  ])("rejects a non-portable verified manifest locator: %s", (manifest) => {
    expect(verifiedCatalogEntrySchema.safeParse({ ...entry, manifest }).success).toBe(false);
  });
});
