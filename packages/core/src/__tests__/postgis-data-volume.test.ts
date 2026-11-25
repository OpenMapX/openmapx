import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

interface Manifest {
  container: { image: string; tag: string; digest?: string };
  volumes?: Array<{ name: string; mountAt: string }>;
}

function read<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...path), "utf8")) as T;
}

/** The verified layout of the PostGIS image both databases run. */
const provenance = read<{
  image: string;
  tag: string;
  indexDigest: string;
  volume: string;
  pgData: string;
}>("services", "postgis", "image-provenance.json");

describe("PostgreSQL data lies in each database's declared volume", () => {
  it.each(["postgis", "dawarich-postgis"])("%s", (serviceId) => {
    const manifest = read<Manifest>("services", serviceId, "service.json");
    // The provenance describes this exact image; another image needs its own.
    expect(manifest.container).toMatchObject({
      image: provenance.image,
      tag: provenance.tag,
      digest: provenance.indexDigest,
    });
    // A mount elsewhere would leave PGDATA in an anonymous volume that a
    // container removal discards, or keep the container from starting.
    const volume = manifest.volumes?.find((entry) => entry.mountAt === provenance.volume);
    expect(volume, `a volume mounted at ${provenance.volume}`).toBeDefined();
    expect(provenance.pgData.startsWith(`${provenance.volume}/`)).toBe(true);
  });
});
