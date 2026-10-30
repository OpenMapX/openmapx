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

  it("rejects an unknown endpoint in a URL template or a header, naming the known ones", () => {
    const result = withHealthCheck([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      { name: "a", type: "http", urlTemplate: "${endpoint:nominatim}/status" },
      {
        name: "b",
        type: "http",
        url: "https://example.org/status",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
        headers: { "X-Upstream": "${endpoint:}" },
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      'manifest.healthCheck: unknown endpoint "nominatim" in ${endpoint:nominatim} (known: overpass)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      'manifest.healthCheck: unknown endpoint "" in ${endpoint:} (known: overpass)',
    ]);
  });
});
