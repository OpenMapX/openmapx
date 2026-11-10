// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are literal Docker Compose references under test
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose, renderServiceSnippet } from "../services/compose-renderer";
import { validateServiceManifest } from "../services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../services/types";

const validateCommunity = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });
const validateFirstParty = (raw: unknown) => validateServiceManifest(raw, { firstParty: true });

function manifest(container: Record<string, unknown> = {}, quality = "community") {
  return {
    id: "community-limits",
    name: "Community Limits",
    version: "1.0.0",
    quality,
    container: { image: "alpine", tag: "latest", expose: [8080], ...container },
  };
}

function service(
  overrides: Partial<ServiceManifest["container"]>,
  { builtIn }: { builtIn: boolean },
): LoadedService {
  return {
    manifest: {
      id: builtIn ? "first-party-limits" : "community-limits",
      name: "Limits",
      version: "1.0.0",
      quality: builtIn ? "built-in" : "community",
      container: { image: "alpine", tag: "latest", expose: [8080], ...overrides },
    },
    directory: "/tmp/limits",
    isBuiltIn: builtIn,
    enabled: true,
  };
}

describe("community container memory limit", () => {
  it("is required", () => {
    const result = validateCommunity(manifest());
    expect(result.valid).toBe(false);
    expect(result.errors?.join("\n")).toMatch(/community_memory_limit_required/);
  });

  it.each(["64m", "512m", "1g", "1.5g", "2G", "512MB", "1024k"])("accepts %s", (memory) => {
    expect(validateCommunity(manifest({ memory })).valid).toBe(true);
  });

  it.each([
    "",
    "0m",
    "0g",
    "512",
    "512x",
    "-1g",
    "lots",
    "1e3m",
    "512m 1g",
    "512m; privileged",
    "m",
    "${MEMORY}",
    "${MEMORY:-512m}",
    "$MEMORY",
  ])("rejects %j", (memory) => {
    const result = validateCommunity(manifest({ memory }));
    expect(result.valid).toBe(false);
    expect(result.errors?.join("\n")).toMatch(/community_memory_limit_required/);
  });

  it("is not required of a first-party service", () => {
    expect(validateFirstParty(manifest({}, "built-in")).valid).toBe(true);
  });

  it("is checked again when a hand-built community service is rendered", () => {
    expect(() => renderServiceSnippet(service({}, { builtIn: false }), {})).toThrow(
      /community_memory_limit_required/,
    );
    expect(() =>
      renderServiceSnippet(service({ memory: "${POSTGRES_PASSWORD}" }, { builtIn: false }), {}),
    ).toThrow(/community_memory_limit_required/);
  });
});

describe("community container hardening", () => {
  it("limits processes, blocks privilege gain and keeps the memory limit", () => {
    const snippet = renderServiceSnippet(service({ memory: "256m" }, { builtIn: false }), {});
    expect(snippet.pids_limit).toBe(512);
    expect(snippet.security_opt).toEqual(["no-new-privileges:true"]);
    expect(snippet.deploy?.resources?.limits?.memory).toBe("256m");
  });

  it("appears in the rendered Compose file", () => {
    const { composeYaml } = renderCompose([service({ memory: "256m" }, { builtIn: false })], {});
    const rendered = load(composeYaml) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(rendered.services["community-limits"]).toMatchObject({
      pids_limit: 512,
      security_opt: ["no-new-privileges:true"],
      deploy: { resources: { limits: { memory: "256m" } } },
    });
  });

  it("leaves a first-party service as the manifest declares it", () => {
    const snippet = renderServiceSnippet(service({}, { builtIn: true }), {});
    expect(snippet).not.toHaveProperty("pids_limit");
    expect(snippet).not.toHaveProperty("security_opt");
    expect(snippet.deploy).toBeUndefined();

    const sized = renderServiceSnippet(service({ memory: "2g" }, { builtIn: true }), {});
    expect(sized.deploy?.resources?.limits?.memory).toBe("2g");
    expect(sized).not.toHaveProperty("pids_limit");
    expect(sized).not.toHaveProperty("security_opt");
  });
});
