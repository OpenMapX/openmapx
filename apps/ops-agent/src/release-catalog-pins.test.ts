import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeGbfsCatalogLock,
  decodeTransitousLock,
  MOBILITYDATA_GBFS_CATALOG_COMMIT,
} from "@openmapx/transitous-core";
import { describe, expect, it } from "vitest";
import { releaseGbfsCatalogPin, releaseTransitousPin } from "./release-catalog-pins";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tracked = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "infra", "docker", name), "utf8")) as unknown;

describe("the release's catalog pins", () => {
  it("are the repository's tracked pins, run from source", () => {
    expect(releaseTransitousPin()).toEqual(decodeTransitousLock(tracked("transitous.lock.json")));
    expect(releaseGbfsCatalogPin()).toEqual(
      decodeGbfsCatalogLock(tracked("gbfs-catalog.lock.json")),
    );
    expect(releaseGbfsCatalogPin().commit).toBe(MOBILITYDATA_GBFS_CATALOG_COMMIT);
  });
});
