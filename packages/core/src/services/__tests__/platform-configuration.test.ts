import { describe, expect, it } from "vitest";
import {
  platformConfigurationSchema,
  resolvePlatformConfiguration,
} from "../platform-configuration";

describe("platform ownership", () => {
  it("keeps legacy host defaults and excludes unrelated credentials", () => {
    expect(resolvePlatformConfiguration({ env: { BETTER_AUTH_SECRET: "never-copy" } })).toEqual({
      values: {
        domain: "localhost",
        acmeEmail: "admin@example.com",
        releaseSelector: "main",
        defaultRegion: null,
        backupRetentionDays: 30,
      },
      sources: {
        domain: "host",
        acmeEmail: "host",
        releaseSelector: "host",
        defaultRegion: "host",
        backupRetentionDays: "host",
      },
      warnings: [],
    });
  });
  it("retains explicit adoption, invocation override and return to host", () => {
    const saved = platformConfigurationSchema.parse({
      version: 1,
      domain: { source: "database", value: "maps.example.test" },
      defaultRegion: { source: "database", value: "europe/germany" },
    });
    const env = { DOMAIN: "host.example.test", OPENMAPX_REGION: "europe/france" };
    expect(resolvePlatformConfiguration({ saved, env }).values).toMatchObject({
      domain: "maps.example.test",
      defaultRegion: "europe/germany",
    });
    expect(
      resolvePlatformConfiguration({ saved, env, overrides: { domain: "once.example.test" } }),
    ).toMatchObject({ values: { domain: "once.example.test" }, sources: { domain: "invocation" } });
    expect(
      resolvePlatformConfiguration({ saved: { ...saved, domain: { source: "host" } }, env }).values
        .domain,
    ).toBe("host.example.test");
    expect(
      platformConfigurationSchema.safeParse({
        version: 1,
        domain: { source: "host", value: "stale.test" },
      }).success,
    ).toBe(false);
  });
  it.each([
    ["domain", "https://maps.test"],
    ["domain", "maps.test:443"],
    ["domain", "a..test"],
    ["domain", "-maps.test"],
    ["domain", "map_test"],
    ["acmeEmail", "not-email"],
    ["releaseSelector", "latest"],
    ["defaultRegion", "../outside"],
    ["defaultRegion", "https://data.test"],
    ["backupRetentionDays", 0],
    ["backupRetentionDays", 36501],
  ])("rejects malformed %s", (key, value) => {
    expect(
      platformConfigurationSchema.safeParse({ version: 1, [key]: { source: "database", value } })
        .success,
    ).toBe(false);
  });
  it("rejects unknown fields and invalid host configuration instead of exporting a secret map", () => {
    expect(
      platformConfigurationSchema.safeParse({
        version: 1,
        redisPassword: { source: "database", value: "secret" },
      }).success,
    ).toBe(false);
    expect(() => resolvePlatformConfiguration({ env: { DOMAIN: "bad/path" } })).toThrow();
  });
});
