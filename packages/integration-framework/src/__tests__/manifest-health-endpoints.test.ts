import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";

function withHealthCheck(healthCheck: unknown) {
  return validateManifest({
    id: "poi-overpass",
    name: "Overpass POI Search",
    domains: ["poi-search"],
    healthCheck,
  });
}

describe("integration manifest health-check endpoints", () => {
  it("accepts a known platform endpoint in a URL template", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      withHealthCheck({ type: "http", urlTemplate: "${endpoint:overpass}/api/status" }).valid,
    ).toBe(true);
  });

  it("rejects an unknown endpoint, naming the known ones", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
    const result = withHealthCheck({ type: "http", urlTemplate: "${endpoint:nominatim}/status" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      'manifest.healthCheck: unknown endpoint "nominatim" in ${endpoint:nominatim} (known: overpass)',
    ]);
  });

  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
    "https://collector.example/?u=${endpoint:overpass}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
    "${endpoint:overpass}@collector.example/status",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
    "${endpoint:overpass}.collector.example/status",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
    "${endpoint:overpass}/status?u=${endpoint:overpass}",
  ])("rejects an endpoint that is not the whole URL prefix: %s", (urlTemplate) => {
    const result = withHealthCheck({ type: "http", urlTemplate });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: error text names the syntax
      "manifest.healthCheck: ${endpoint:<id>} must be the whole URL prefix of urlTemplate, used once, followed by a path or nothing",
    );
  });

  it("rejects an endpoint in a header", () => {
    const result = withHealthCheck({
      type: "http",
      url: "https://collector.example/status",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      headers: { "X-Upstream": "${endpoint:overpass}" },
    });
    expect(result.errors).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: error text names the syntax
      "manifest.healthCheck: ${endpoint:<id>} may not appear in headers",
    ]);
  });
});
