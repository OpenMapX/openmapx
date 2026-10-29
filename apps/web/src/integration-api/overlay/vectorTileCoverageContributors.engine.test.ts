// @vitest-environment node
import type { Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { flowFeatureContributorKey, flowFeatureContributors } from "./flowContributors";
import { createVectorTileCoverageContributorResolver } from "./vectorTileCoverageContributors";

// Fixed MVT fixture: two line segments with independently captured retrieval
// dates, explicit empty geometry/confidence and one measurement publisher.
const MVT =
  "GqsDeAIKCHNlZ21lbnRzEhASBAAAAQIYAiIGCQICCgICEhASBAABAQIYAiIGCQICCgICGhJmaWVsZF9jb250cmlidXRvcnMaC3NwZWVkX3JhdGlvIqUBCqIBeyJnZW9tZXRyeSI6W10sInJhdGlvIjpbeyJzb3VyY2VJZCI6Im1lYXN1cmVtZW50IiwibmFtZSI6Ik1lYXN1cmVtZW50IHB1Ymxpc2hlciIsImF0dHJpYnV0aW9uVGV4dCI6IkNhcHR1cmVkIG5vdGljZSIsInJldHJpZXZlZEF0IjoiMjAyNi0xMC0xNSJ9XSwiY29uZmlkZW5jZSI6W119IqUBCqIBeyJnZW9tZXRyeSI6W10sInJhdGlvIjpbeyJzb3VyY2VJZCI6Im1lYXN1cmVtZW50IiwibmFtZSI6Ik1lYXN1cmVtZW50IHB1Ymxpc2hlciIsImF0dHJpYnV0aW9uVGV4dCI6IkNhcHR1cmVkIG5vdGljZSIsInJldHJpZXZlZEF0IjoiMjAyNi0xMC0xNiJ9XSwiY29uZmlkZW5jZSI6W119IgUKAzAuNSiAIA==";
const root = "../../../../../node_modules/maplibre-gl/src/";

describe("installed MapLibre vector tile coverage bridge", () => {
  it("decodes actual MVT receipts, survives retained/reparsed data, and reads real evaluated paint", async () => {
    const [
      { FeatureIndex },
      { Tile },
      { OverscaledTileID },
      { StyleLayer },
      { EvaluationParameters },
      { default: properties },
    ] = await Promise.all([
      import(`${root}data/feature_index.ts`),
      import(`${root}tile/tile.ts`),
      import(`${root}tile/tile_id.ts`),
      import(`${root}style/style_layer.ts`),
      import(`${root}style/evaluation_parameters.ts`),
      import(`${root}style/style_layer/line_style_layer_properties.g.ts`),
    ]);
    const id = new OverscaledTileID(8, 0, 8, 128, 128);
    const tile = new Tile(id, 512);
    const layer = new StyleLayer(
      {
        id: "color",
        type: "line",
        source: "flow",
        "source-layer": "segments",
        minzoom: 6,
        paint: { "line-opacity": 1, "line-width": 2 },
      },
      properties,
      {},
    );
    const recalculate = () => {
      layer.updateTransitions({ now: 0, transition: { duration: 0 } });
      layer.recalculate(new EvaluationParameters(8), []);
    };
    recalculate();
    const source = {};
    const style = { getLayer: () => layer };
    const buffer = Uint8Array.from(Buffer.from(MVT, "base64")).buffer;
    const commit = (rawTileData?: ArrayBuffer) => {
      tile.loadVectorData(
        {
          featureIndex: new FeatureIndex(id),
          rawTileData,
          encoding: "mvt",
          buckets: [],
          collisionBoxArray: [],
        },
        style,
      );
      tile.buckets.color = { uploaded: true, isEmpty: () => false, destroy: () => {} };
    };
    commit(buffer);
    const map = {
      getLayer: () => layer,
      getZoom: () => 8,
      getSource: () => source,
      style: {
        ...style,
        tileManagers: {
          flow: { getSource: () => source, getVisibleCoordinates: () => [id], getTile: () => tile },
        },
      },
    } as unknown as MapLibreMap;
    const read = createVectorTileCoverageContributorResolver({
      sourceId: "flow",
      sourceLayer: "segments",
      layerIds: ["color"],
      featureContributorKey: (p) => flowFeatureContributorKey(p, "color"),
      resolveFeatureContributors: (p) => flowFeatureContributors(p, "color"),
    });
    const expected = ["2026-10-15", "2026-10-16"].map((retrievedAt) => ({
      sourceId: "measurement",
      name: "Measurement publisher",
      attributionText: "Captured notice",
      retrievedAt,
    }));
    expect(read(map)).toEqual(expected);
    const decode = vi.spyOn(tile.latestFeatureIndex, "loadVTLayers");
    expect(read(map)).toEqual(expected);
    expect(decode).not.toHaveBeenCalled();
    tile.state = "reloading";
    expect(read(map)).toEqual(expected);
    tile.state = "expired";
    expect(read(map)).toEqual(expected);
    commit(); // Worker style reparse reuses latestRawTileData.
    const reparseDecode = vi.spyOn(tile.latestFeatureIndex, "loadVTLayers");
    expect(read(map)).toEqual(expected);
    expect(reparseDecode).not.toHaveBeenCalled();
    tile.loadVectorData({ etagUnmodified: true }, style);
    expect(read(map)).toEqual(expected);
    // A hard failure that makes the engine stop drawing the tile owes no credit.
    tile.state = "errored";
    expect(read(map)).toEqual([]);
    commit(buffer.slice(0));
    expect(read(map)).toEqual(expected);
    layer.setPaintProperty("line-opacity", 0);
    recalculate();
    expect(read(map)).toEqual([]);
    layer.setPaintProperty("line-opacity", 1);
    recalculate();
    expect(read(map)).toEqual(expected);
    layer.setPaintProperty("line-width", 0);
    recalculate();
    expect(read(map)).toEqual([]);
    layer.setPaintProperty("line-width", 2);
    recalculate();
    tile.unloadVectorData();
    expect(read(map)).toEqual([]);
  });
});
