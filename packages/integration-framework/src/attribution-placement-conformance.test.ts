import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAttributionPresentation } from "@openmapx/core/attribution";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { dataSourceToAttribution } from "./manifest";

const root = resolve(import.meta.dirname, "../../..");
const sources = (integration: string) =>
  JSON.parse(readFileSync(resolve(root, "integrations", integration, "manifest.json"), "utf8"))
    .dataSources;

describe("source-specific placement conformance", () => {
  it.each(["weather-openweathermap", "photos-mapillary", "street-level-imagery-mapillary"])(
    "retains the provider's branding even beside an eligible CC grant: %s",
    (integration) => {
      const source = sources(integration)[0];
      expect(parseLicensing(source.licensing)).toBeDefined();
      const result = buildAttributionPresentation(
        dataSourceToAttribution(source),
        integration.startsWith("weather") ? "content" : "image",
      );
      expect(result.visibleHtml).not.toBe("");
      expect(result.logos.length).toBeGreaterThan(0);
      expect(result.fullHtml).not.toBe("");
    },
  );
  it("does not move unresolved IOC usage conditions into details based on a sibling grant", () => {
    const source = sources("knowledge-tides-ioc")[0];
    const result = buildAttributionPresentation(dataSourceToAttribution(source), "content");
    expect(result.visibleHtml).not.toBe("");
    expect(
      source.licensing.bindings.some(
        (binding: { attribution?: { basis: string } }) =>
          binding.attribution?.basis === "unresolved",
      ),
    ).toBe(true);
  });
});
