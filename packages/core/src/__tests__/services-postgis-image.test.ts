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
      "sha256:8784f86b3e0e046859c96ea25eb8b10f0b801fd891b99a82b82f28ac4a643db8",
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
      verifiedAt: "2026-10-11",
      indexDigest: "sha256:8784f86b3e0e046859c96ea25eb8b10f0b801fd891b99a82b82f28ac4a643db8",
      architectures: {
        "linux/amd64": "sha256:710551e3e00789cab637f11aba26fbdee501f9bead2c8775309eb5f2ff2eefa2",
        "linux/arm64": "sha256:91bb3d493c904e264c795730cb79e1f681551d9193a985e00fd5ca44e3766031",
      },
      ociCreated: "2026-10-06T05:29:21.366027207Z",
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
