import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const serviceDir = join(repoRoot, "services", "postgis");
const manifestPath = join(serviceDir, "service.json");

type ServiceManifest = {
  id: string;
  volumes: Array<{ name: string; mountAt: string; backup: boolean; backupMode: string }>;
};

describe("platform PostGIS image contract", () => {
  it("keeps the database volume and its pg_dump backup", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ServiceManifest;

    expect(manifest.id).toBe("postgis");
    expect(manifest.volumes).toContainEqual({
      name: "openmapx-pgdata",
      mountAt: "/var/lib/postgresql",
      backup: true,
      backupMode: "pg_dump",
    });
  });
});
