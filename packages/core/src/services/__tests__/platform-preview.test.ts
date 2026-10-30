import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../compose-renderer";
import { buildPlatformConfigurationPreview } from "../platform-preview";
import type { LoadedService } from "../types";

const services: LoadedService[] = [
  "app-api",
  "app-web",
  "traefik",
  "tileserver",
  "ops-agent",
  "data-manager",
  "redis",
].map((id) => ({
  manifest: JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../../../services", id, "service.json"),
      "utf8",
    ),
  ),
  directory: "/synthetic/" + id,
  isBuiltIn: true,
  enabled: true,
}));
const input = () => ({
  actorId: "admin-a",
  previewId: "08be2da1-c0b5-46a8-a85e-aaedb03ff7bf",
  authPolicyRevision: "a".repeat(64),
  sourceRevision: "ef854296-a818-4cd6-a4be-c1e28be376ac",
  currentRevisionId: `cfg1_${"a".repeat(43)}`,
  expectedCurrentRevisionId: `cfg1_${"a".repeat(43)}`,
  env: { DOMAIN: "old.example.test", ACME_EMAIL: "host@example.test" },
  changes: {
    version: 1 as const,
    domain: { source: "database" as const, value: "new.example.test" },
  },
  services,
});
describe("platform configuration preview", () => {
  it("previews an explicit protected resource reconciliation without inventing a global setting change", () => {
    const base = { ...input(), changes: { version: 1 as const } };
    const preview = buildPlatformConfigurationPreview({
      ...base,
      reconcileServiceIds: ["ops-agent"],
    });
    expect(preview.affectedServiceIds).toEqual(["ops-agent"]);
    expect(preview.configuration).toEqual({ version: 1 });
    expect(preview.oldOrigin).toBe(preview.newOrigin);
    expect(preview.requiredConfirmation.domain).toBe(false);
    expect(preview.previewFingerprint).not.toBe(
      buildPlatformConfigurationPreview(base).previewFingerprint,
    );
    expect(() =>
      buildPlatformConfigurationPreview({ ...base, reconcileServiceIds: ["data-manager"] }),
    ).toThrow();
    expect(() =>
      buildPlatformConfigurationPreview({
        ...base,
        services: services.map((service) => ({ ...service, enabled: false })),
        reconcileServiceIds: ["ops-agent"],
      }),
    ).toThrow();
  });
  it("shows exact public origin consumers and requires domain recovery confirmation", () => {
    const source = input();
    const preview = buildPlatformConfigurationPreview(source);
    expect(preview).toMatchObject({
      oldOrigin: "https://old.example.test",
      newOrigin: "https://new.example.test",
      requiredConfirmation: {
        domain: true,
        dnsTls: true,
        oauth: true,
        passkeys: true,
        alternateLogin: true,
      },
      originConsumers: {
        routingHost: "new.example.test",
        corsOrigin: "https://new.example.test",
        authUrl: "https://new.example.test",
        passkeyRpId: "new.example.test",
        passkeyOrigin: "https://new.example.test,openmapx://",
        webApiUrl: "https://new.example.test",
        tilesPublicUrl: "https://new.example.test/tiles/",
      },
    });
    expect(preview.affectedServiceIds).toEqual(["app-api", "app-web", "tileserver", "traefik"]);
    expect(source.env.DOMAIN).toBe("old.example.test");
  });
  it("binds preview identity, actor, policy, source and exact intent without including secrets", () => {
    const initial = buildPlatformConfigurationPreview(input());
    expect(buildPlatformConfigurationPreview(input()).previewFingerprint).toBe(
      initial.previewFingerprint,
    );
    for (const change of [
      { actorId: "admin-b" },
      { authPolicyRevision: "b".repeat(64) },
      { sourceRevision: "27142d4e-1db8-43b8-a4a4-becdfddbb368" },
      { previewId: "4ad04498-79fc-4fe5-b059-78c3440440da" },
    ])
      expect(
        buildPlatformConfigurationPreview({ ...input(), ...change }).previewFingerprint,
      ).not.toBe(initial.previewFingerprint);
    expect(
      JSON.stringify(
        buildPlatformConfigurationPreview({
          ...input(),
          env: { ...input().env, DATABASE_URL: "never-public" },
        }),
      ),
    ).not.toContain("never-public");
  });
  it("rejects stale revisions, unknown fields and invalid origins before a desired change", () => {
    expect(() =>
      buildPlatformConfigurationPreview({ ...input(), expectedCurrentRevisionId: null }),
    ).toThrow(/revision/i);
    expect(() =>
      buildPlatformConfigurationPreview({
        ...input(),
        changes: { ...input().changes, unknown: true },
      } as never),
    ).toThrow();
    expect(() =>
      buildPlatformConfigurationPreview({
        ...input(),
        changes: { version: 1, domain: { source: "database", value: "https://bad.example/path" } },
      }),
    ).toThrow();
  });
  it("preserves unrelated adopted settings and derives actual release/retention consumers", () => {
    const preview = buildPlatformConfigurationPreview({
      ...input(),
      currentPlatform: {
        version: 1,
        acmeEmail: { source: "database", value: "saved@example.test" },
      },
      changes: { version: 1, backupRetentionDays: { source: "database", value: 60 } },
    });
    expect(preview.configuration.acmeEmail).toEqual({
      source: "database",
      value: "saved@example.test",
    });
    expect(preview.values.backupRetentionDays).toBe(60);
    expect(preview.requiredConfirmation.domain).toBe(false);
    expect(preview.affectedServiceIds).toEqual(["app-api", "ops-agent"]);
  });
  it("can explicitly return a field to host ownership without changing the host", () => {
    const preview = buildPlatformConfigurationPreview({
      ...input(),
      currentPlatform: {
        version: 1,
        domain: { source: "database", value: "previous.example.test" },
      },
      changes: { version: 1, domain: { source: "host" } },
    });
    expect(preview.newOrigin).toBe("https://old.example.test");
    expect(preview.sources.domain).toBe("host");
  });
});

it("materializes the adopted origin in every actual built-in origin consumer", () => {
  const preview = buildPlatformConfigurationPreview(input());
  const context = {
    domain: preview.values.domain,
    platform: preview.configuration,
    platformValues: preview.values,
    existsSync: () => true,
    allServices: services,
  };
  const byId = (id: string) =>
    renderServiceSnippet(services.find((s) => s.manifest.id === id)!, context);
  expect(byId("app-api").environment).toMatchObject({
    DOMAIN: "new.example.test",
    CORS_ORIGIN: "https://new.example.test",
    BETTER_AUTH_URL: "https://new.example.test",
    PASSKEY_RP_ID: "new.example.test",
    PASSKEY_ORIGIN: "https://new.example.test,openmapx://",
  });
  expect(byId("app-web").environment?.NEXT_PUBLIC_API_URL).toBe("https://new.example.test");
  expect(byId("tileserver").command).toEqual(["--public_url", "https://new.example.test/tiles/"]);
});
