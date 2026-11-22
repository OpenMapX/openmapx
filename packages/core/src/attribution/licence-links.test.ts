import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { licenceLink } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { buildAttributionPresentation } from "./attribution";
import { projectAttributionPresentations } from "./attribution-presentation";

const INTEGRATIONS = fileURLToPath(new URL("../../../../integrations/", import.meta.url));

interface ManifestSource {
  sourceId: string;
  name: string;
  url?: string;
  attribution?: string;
  licensing?: {
    bindings?: { license: { kind: string; expression?: string; url?: string } }[];
  };
}

const manifests = readdirSync(INTEGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z0-9]/.test(entry.name))
  .map((entry) => ({
    id: entry.name,
    sources: (JSON.parse(readFileSync(join(INTEGRATIONS, entry.name, "manifest.json"), "utf8"))
      .dataSources ?? []) as ManifestSource[],
  }));

function source(integration: string, sourceId: string): Attribution {
  const found = manifests
    .find((manifest) => manifest.id === integration)
    ?.sources.find((entry) => entry.sourceId === sourceId);
  if (!found) throw new Error(`${integration}:${sourceId} is not declared`);
  return {
    sourceId: found.sourceId,
    name: found.name,
    url: found.url,
    attributionText: found.attribution,
    licensing: found.licensing,
  } as Attribution;
}

describe("licence links", () => {
  it("every declared standard licence links its one canonical page", () => {
    // A source's own licensing page belongs in its declarations; the licence
    // name links the licence, so equal credits from two sources can collapse.
    const drift = manifests.flatMap(({ id, sources }) =>
      sources.flatMap((entry) =>
        (entry.licensing?.bindings ?? []).flatMap(({ license }) => {
          if (license.kind !== "spdx" || !license.expression || !license.url) return [];
          const canonical = licenceLink(license.expression);
          return canonical && canonical !== license.url
            ? [`${id}:${entry.sourceId} ${license.expression} → ${license.url}`]
            : [];
        }),
      ),
    );
    expect(drift).toEqual([]);
  });

  it("shows one OpenStreetMap credit for the route and the map data beside it", () => {
    const shown = projectAttributionPresentations(
      [source("routing", "overpass"), source("routing-valhalla", "valhalla")].map((credit) =>
        buildAttributionPresentation(credit, "map"),
      ),
    ).visible;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.html).toContain("Valhalla");
  });
});
