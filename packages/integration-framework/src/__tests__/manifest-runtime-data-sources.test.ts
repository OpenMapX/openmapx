import { describe, expect, it } from "vitest";
import type { IntegrationContext } from "../context.js";
import { validateDataSource, validateManifest } from "../manifest.js";
import { createMockIntegrationContext } from "../testing/index.js";

const source = {
  sourceId: "nl-ndw-events",
  name: "NDW",
  url: "https://www.ndw.nu",
  license: "CC0-1.0",
  providerCountry: "NL",
  providerPrivacyUrl: "https://www.ndw.nu/privacy",
  domain: "road-conditions",
};

const runtimeManifest = {
  id: "runtime-probe",
  domains: ["road-conditions", "fuel-stations"],
  runtimeDataSources: true,
};

describe("runtimeDataSources manifest flag", () => {
  it("accepts a runtime manifest without static data sources", () => {
    expect(validateManifest(runtimeManifest)).toEqual({ valid: true, errors: [] });
  });

  it("a runtime manifest with static dataSources is rejected", () => {
    const result = validateManifest({ ...runtimeManifest, dataSources: [source] });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/runtimeDataSources/);
  });

  it("accepts an empty static list next to the flag", () => {
    expect(validateManifest({ ...runtimeManifest, dataSources: [] }).valid).toBe(true);
  });

  it("only accepts the literal true", () => {
    expect(validateManifest({ ...runtimeManifest, runtimeDataSources: false }).valid).toBe(false);
  });
});

describe("validateDataSource", () => {
  const domains = runtimeManifest.domains;

  it("returns the parsed source when it is valid", () => {
    const result = validateDataSource({ ...source, extra: "dropped" }, domains);
    expect(result).toEqual({ valid: true, errors: [], dataSource: source });
  });

  it("rejects a source missing a required field", () => {
    const { providerPrivacyUrl: _omitted, ...rest } = source;
    const result = validateDataSource(rest, domains);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/providerPrivacyUrl/);
  });

  it("rejects an empty required field with the manifest-load message", () => {
    const result = validateDataSource({ ...source, license: "" }, domains);
    expect(result.errors).toContain("dataSources[].license is required");
  });

  it("rejects a domain outside the manifest domains", () => {
    const result = validateDataSource({ ...source, domain: "weather" }, domains);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/not one of the manifest domains/);
  });

  it("rejects an invalid feed id", () => {
    expect(validateDataSource({ ...source, sourceId: "Bad_Id" }, domains).valid).toBe(false);
  });

  it("is the rule validateManifest applies to static sources", () => {
    const result = validateManifest({
      id: "static-probe",
      domains: ["road-conditions"],
      dataSources: [{ ...source, domain: "weather" }],
    });
    expect(result.errors).toEqual(
      validateDataSource({ ...source, domain: "weather" }, ["road-conditions"]).errors,
    );
  });
});

describe("mock context setDataSources", () => {
  it("records every call", () => {
    const ctx = createMockIntegrationContext();
    ctx.setDataSources([source]);
    ctx.setDataSources([]);
    expect(ctx.registered.dataSourceLists).toEqual([[source], []]);
  });

  it("returns the sources the host rules accept, as the host does", () => {
    const ctx = createMockIntegrationContext({
      manifest: runtimeManifest as unknown as IntegrationContext["manifest"],
    });
    const accepted = ctx.setDataSources([
      source,
      { ...source, sourceId: "xx-no-homepage-events", url: "" },
      { ...source, sourceId: "xx-weather-events", domain: "weather" },
      { ...source, name: "Duplicate" },
    ]);
    expect(accepted).toEqual([source]);
    expect(ctx.registered.dataSourceLists[0]).toHaveLength(4);
  });
});
