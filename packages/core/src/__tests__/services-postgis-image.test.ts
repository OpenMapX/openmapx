import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const serviceDir = join(repoRoot, "services", "postgis");
const manifestPath = join(serviceDir, "service.json");
const provenancePath = join(serviceDir, "image-provenance.json");

type ServiceManifest = {
  id: string;
  container: { image: string; tag: string; digest: string };
  volumes: Array<{ name: string; mountAt: string; backup: boolean; backupMode: string }>;
};

type ImageProvenance = {
  image: string;
  tag: string;
  verifiedAt: string;
  indexDigest: string;
  architectures: Record<string, string>;
  ociCreated: string;
  source: string;
  sourceRevision: string;
  baseImage: string;
  postgresVersion: string;
  postgisVersion: string;
  volume: string;
  pgData: string;
  rebuildCadence: string;
  support: string;
  mutableTagPolicy: string;
};

describe("platform PostGIS image contract", () => {
  it("uses the reviewed Bao multiarch image without changing persistence and backup", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ServiceManifest;

    expect(manifest.id).toBe("postgis");
    expect(`${manifest.container.image}:${manifest.container.tag}`).toBe(
      "ghcr.io/baosystems/postgis:18-3.6",
    );
    expect(manifest.container.digest).toBe(
      "sha256:7de6306fe0718b72eebea405f2ff2ed9a3581a002ee1251978eba7b5e51c16b6",
    );
    expect(manifest.volumes).toContainEqual({
      name: "openmapx-pgdata",
      mountAt: "/var/lib/postgresql",
      backup: true,
      backupMode: "pg_dump",
    });
  });

  it("records the exact reviewed mutable-image provenance and release policy", () => {
    expect(existsSync(provenancePath)).toBe(true);
    if (!existsSync(provenancePath)) return;

    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as ImageProvenance;
    expect(provenance).toEqual({
      image: "ghcr.io/baosystems/postgis",
      tag: "18-3.6",
      verifiedAt: "2026-08-09",
      indexDigest: "sha256:7de6306fe0718b72eebea405f2ff2ed9a3581a002ee1251978eba7b5e51c16b6",
      architectures: {
        "linux/amd64": "sha256:52edddd0a2cd4451bafc5772b83646c8c2f787a90c21bf1ce98c95113fdbf431",
        "linux/arm64": "sha256:a6eb9820bd66eea92cb7ccbd9f9e0f36d6768678b65f9f02d2a6353c382caa4c",
      },
      ociCreated: "2026-08-04T06:10:05.427482305Z",
      source: "https://github.com/baosystems/docker-postgis",
      sourceRevision: "603ccfa15a094bf677524275bdf7e8a7478885ce",
      baseImage: "docker.io/postgis/postgis:18-3.6",
      postgresVersion: "18.4",
      postgisVersion: "3.6.4",
      volume: "/var/lib/postgresql",
      pgData: "/var/lib/postgresql/18/docker",
      rebuildCadence: "weekly",
      support: "none",
      mutableTagPolicy: "stop-release-and-review-on-digest-drift",
    });
  });
});
