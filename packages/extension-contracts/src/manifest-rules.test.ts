import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "./extension";
import { COMPONENT_ID_PATTERN, componentIdSchema, isComponentId } from "./identifiers";
import { validateManifest } from "./integration";
import { compareSemver, isSemver } from "./semver";
import { validateServiceManifest } from "./service";

const communityIntegration = {
  id: "acme-weather",
  version: "1.2.0",
  platform: "1.0",
  domains: ["weather"],
  quality: "community",
};

const communityService = {
  id: "acme-router",
  name: "Acme router",
  version: "1.0.0",
  platform: "1.0",
  quality: "community",
  container: {
    image: "ghcr.io/acme/router",
    tag: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    expose: [8080],
    memory: "256m",
  },
};

const extension = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  platform: "1.0",
  integrations: [
    {
      artifact: "https://example.test/acme-weather.tar.gz",
      sha256: "b".repeat(64),
      id: "acme-weather",
    },
  ],
};

const community = { firstParty: false };
const builtIn = { firstParty: true };

describe("component ids", () => {
  it.each(["a", "osm", "live-transit-entur", "a1-b2", "x".repeat(48)])("accepts %s", (id) => {
    expect(isComponentId(id)).toBe(true);
    expect(componentIdSchema.safeParse(id).success).toBe(true);
    expect(COMPONENT_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(["", "a--b", "abc-", "-abc", "Abc", "a_b", "a.b", "x".repeat(49)])("refuses %s", (id) => {
    expect(isComponentId(id)).toBe(false);
    expect(componentIdSchema.safeParse(id).success).toBe(false);
    expect(COMPONENT_ID_PATTERN.test(id)).toBe(false);
  });

  it("applies to every manifest kind and to bundle component references", () => {
    expect(validateManifest({ ...communityIntegration, id: "a--b" }, community).valid).toBe(false);
    expect(validateServiceManifest({ ...communityService, id: "abc-" }, community).valid).toBe(
      false,
    );
    expect(validateExtensionManifest({ ...extension, id: "x".repeat(49) }).valid).toBe(false);
    expect(
      validateExtensionManifest({
        ...extension,
        integrations: [{ ...extension.integrations[0], id: "a--b" }],
      }).valid,
    ).toBe(false);
    expect(
      validateExtensionManifest({
        ...extension,
        config: [{ key: "k", target: `integration:${"x".repeat(49)}` }],
      }).valid,
    ).toBe(false);
  });
});

describe("community integration manifests", () => {
  it("accept a manifest that states protocol and semantic version", () => {
    expect(validateManifest(communityIntegration, community)).toEqual({ valid: true, errors: [] });
  });

  it.each(["platform", "version"])("require %s", (key) => {
    const { [key as keyof typeof communityIntegration]: _, ...rest } = communityIntegration;
    expect(validateManifest(rest, community).valid).toBe(false);
    expect(validateManifest(rest, builtIn).valid).toBe(true);
  });

  it.each(["1", "1.0", "v1.0.0", "latest", "1.0.0.0"])("refuse version %s", (version) => {
    expect(validateManifest({ ...communityIntegration, version }, community).valid).toBe(false);
  });

  it("refuse an unknown top-level key", () => {
    const result = validateManifest({ ...communityIntegration, platfrom: "1.0" }, community);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("platfrom");
  });

  it("refuse any quality label but community", () => {
    for (const quality of ["built-in", "community-verified"])
      expect(validateManifest({ ...communityIntegration, quality }, community).valid).toBe(false);
  });

  it("refuse a required capability that is neither well-known nor namespaced", () => {
    const requires = (capability: string) => [{ capability, optional: true }];
    expect(
      validateManifest({ ...communityIntegration, requires: requires("geocoder") }, community)
        .valid,
    ).toBe(true);
    expect(
      validateManifest({ ...communityIntegration, requires: requires("acme/router") }, community)
        .valid,
    ).toBe(true);
    expect(
      validateManifest({ ...communityIntegration, requires: requires("router") }, community).errors,
    ).toEqual([
      'requires[0].capability: "router" is neither a well-known capability nor namespaced as "<vendor>/<name>"',
    ]);
  });

  it("leave no community-verified label for built-in manifests either", () => {
    expect(
      validateManifest({ ...communityIntegration, quality: "community-verified" }, builtIn).valid,
    ).toBe(false);
  });
});

describe("community service manifests", () => {
  it("accept a manifest that states protocol and semantic version", () => {
    expect(validateServiceManifest(communityService, community)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each(["platform", "version"])("require %s", (key) => {
    const { [key as keyof typeof communityService]: _, ...rest } = communityService;
    expect(validateServiceManifest(rest, community).valid).toBe(false);
  });

  it("validate platform as a major.minor protocol version", () => {
    expect(validateServiceManifest({ ...communityService, platform: "1" }, community).valid).toBe(
      false,
    );
    expect(
      validateServiceManifest(
        { ...communityService, quality: "built-in", platform: "one" },
        builtIn,
      ).valid,
    ).toBe(false);
  });

  it("refuse an unknown top-level key and any quality but community", () => {
    expect(validateServiceManifest({ ...communityService, categry: "x" }, community).valid).toBe(
      false,
    );
    expect(
      validateServiceManifest({ ...communityService, quality: "community-verified" }, community)
        .valid,
    ).toBe(false);
  });

  it("make an un-namespaced capability or data type an error", () => {
    const result = validateServiceManifest(
      {
        ...communityService,
        provides: ["routing-engine", "acme/router", "router"],
        produces: [{ type: "blob", sourceDir: "blob" }],
      },
      community,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'provides[2]: "router" is neither a well-known capability nor namespaced as "<vendor>/<name>" (e.g. "acme/router")',
      'produces[0].type: "blob" is neither a well-known data type nor namespaced as "<vendor>/<name>" (e.g. "acme/blob")',
    ]);
  });
});

describe("extension manifests", () => {
  it("require platform and a semantic version", () => {
    expect(validateExtensionManifest(extension)).toEqual({ valid: true, errors: [] });
    const { platform: _, ...withoutPlatform } = extension;
    expect(validateExtensionManifest(withoutPlatform).valid).toBe(false);
    expect(validateExtensionManifest({ ...extension, version: "2024.1" }).valid).toBe(false);
  });
});

describe("semantic versions", () => {
  it("recognise Semantic Versioning 2.0.0", () => {
    expect(isSemver("1.0.0")).toBe(true);
    expect(isSemver("1.0.0-rc.1+build.5")).toBe(true);
    expect(isSemver("01.0.0")).toBe(false);
    expect(isSemver("1.0")).toBe(false);
  });

  it("order by precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareSemver(ordered[i - 1] as string, ordered[i] as string)).toBe(-1);
      expect(compareSemver(ordered[i] as string, ordered[i - 1] as string)).toBe(1);
    }
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareSemver("1.0", "1.0.0")).toBeNull();
  });
});
