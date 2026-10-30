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
      "sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7",
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
      verifiedAt: "2026-10-29",
      indexDigest: "sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7",
      architectures: {
        "linux/amd64": "sha256:62d73b8e8d5fc992e64e6c5e6c234f75e9f9edf6e23f2a28ab0f783a67bff151",
        "linux/arm64": "sha256:7111f5daf533ec8842f2dc9bca7f6c34598e2b1351f7896e0451b824a0ae2ac3",
      },
      ociCreated: "2026-10-27T05:28:34.556992796Z",
      source: "https://github.com/baosystems/docker-postgis",
      sourceRevision: "7f34aca7765a43924e2e94a45331ca260ad60d99",
      baseImage: "docker.io/postgis/postgis:18-3.6",
      postgresVersion: "18.6",
      postgisVersion: "3.6.4",
      volume: "/var/lib/postgresql",
      pgData: "/var/lib/postgresql/18/docker",
      rebuildCadence: "weekly",
      support: "none",
      mutableTagPolicy: "stop-release-and-review-on-digest-drift",
    });
  });
});
