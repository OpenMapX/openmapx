import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { type DecodedTile, decodeLayers } from "../web/derive/decode";

export const STREET_LAYERS = ["roads", "rails", "crossings", "trees", "furniture", "pitches"];
export const BASEMAP_LAYERS = ["landcover", "landuse", "transportation", "building", "water"];

/** Raw bytes of a gzipped fixture tile. */
export function fixtureBytes(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    gunzipSync(readFileSync(new URL(`./fixtures/${name}.pbf.gz`, import.meta.url))),
  );
}

export function streetFixture(name: string): DecodedTile {
  return decodeLayers(fixtureBytes(name), STREET_LAYERS);
}

export function basemapFixture(name: string): DecodedTile {
  return decodeLayers(fixtureBytes(name), BASEMAP_LAYERS);
}

export const ALEXANDERPLATZ = "street-16-35209-21492-alexanderplatz";
export const TURN_LANES = "street-16-35198-21496-turn-lanes";
export const TRAM = "street-16-35215-21491-tram";
export const A100 = "street-16-35182-21501-a100";
export const PITCH_WEST = "street-16-35214-21499-pitch-west";
export const PITCH_EAST = "street-16-35215-21499-pitch-east";
export const GRUNEWALD = "basemap-14-8795-5376";
export const GRUNEWALD_SOUTH = "basemap-14-8795-5377";

/** Tile coordinates encoded in a fixture name. */
export function fixtureTile(name: string): { z: number; x: number; y: number } {
  const [, z, x, y] = name.split("-");
  return { z: Number(z), x: Number(x), y: Number(y) };
}
