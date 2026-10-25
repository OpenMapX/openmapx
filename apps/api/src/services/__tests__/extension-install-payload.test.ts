import { describe, expect, it } from "vitest";
import { extensionManifestFixture } from "../../routes/__tests__/helpers/extension-admin-fixtures";
import { normalizeExtensionInstallPayload } from "../extension-install-payload";

const base = {
  manifest: {
    id: "fixture-extension",
    name: "Fixture extension",
    version: "1.0.0",
    services: [
      {
        repo: "https://GitHub.com:443/openmapx/community-fixture.git",
        service: "fixture-service",
      },
    ],
    integrations: [
      {
        id: "fixture-integration",
        artifact: "https://EXAMPLE.test:443/releases/../fixture.tar.gz",
        sha256: "a".repeat(64),
      },
    ],
  },
  sourceUrl: "https://EXAMPLE.test:443/releases/../extension.json",
  sourceTrust: "community",
  actorId: "actor-1",
  hostPortConfirmation: "c".repeat(64),
};

describe("normalizeExtensionInstallPayload", () => {
  it("accepts the administration route fixture", () => {
    expect(() =>
      normalizeExtensionInstallPayload({
        manifest: extensionManifestFixture,
        sourceUrl: "https://example.test/extension.json",
        sourceTrust: "community",
      }),
    ).not.toThrow();
  });
  it("returns only canonical durable fields", () => {
    expect(normalizeExtensionInstallPayload({ ...base, ignored: "do-not-persist" })).toEqual({
      ...base,
      manifest: {
        ...base.manifest,
        services: [
          {
            repo: "https://github.com/openmapx/community-fixture.git",
            service: "fixture-service",
          },
        ],
        integrations: [
          {
            ...base.manifest.integrations[0],
            artifact: "https://example.test/fixture.tar.gz",
          },
        ],
      },
      sourceUrl: "https://example.test/extension.json",
    });
  });

  it("does not persist a non-fingerprint confirmation value", () => {
    expect(
      normalizeExtensionInstallPayload({
        ...base,
        hostPortConfirmation:
          "https://sentinel-user:sentinel-password@example.test/private?token=sentinel-query",
      }),
    ).not.toHaveProperty("hostPortConfirmation");
  });

  it.each([
    ["source", { ...base, sourceUrl: "https://example.test/e.json?token=sentinel-secret" }],
    [
      "artifact",
      {
        ...base,
        manifest: {
          ...base.manifest,
          integrations: [
            {
              ...base.manifest.integrations[0],
              artifact: "https://example.test/a.tgz?token=sentinel-secret",
            },
          ],
        },
      },
    ],
    [
      "repository",
      {
        ...base,
        manifest: {
          ...base.manifest,
          services: [
            {
              ...base.manifest.services[0],
              repo: "https://evil.example.test/repo.git",
            },
          ],
        },
      },
    ],
  ])("rejects an unsafe %s without reflecting it", (_kind, payload) => {
    let caught: unknown;
    try {
      normalizeExtensionInstallPayload(payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("sentinel-secret");
    expect(String(caught)).not.toContain("evil.example.test");
  });
});
