import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The runner's isolation is a property of its deployment, not just its code.
 * These assertions read the shipped manifest and image definition so a mount,
 * a network, or a credential cannot be re-added without failing here.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface Manifest {
  container: {
    environment?: Record<string, string>;
    capDrop?: string[];
    user?: string;
    command?: unknown;
    entrypoint?: unknown;
    privileged?: boolean;
    networkMode?: string;
  };
  bindMounts: Array<{ source: string; target: string; readOnly?: boolean; optional?: boolean }>;
  exposure?: unknown;
  communityNetworkAccess?: unknown;
}

const manifest = JSON.parse(read("services/transitous-runner/service.json")) as Manifest;
const dockerfile = read("apps/transitous-runner/Dockerfile");

describe("Transitous runner isolation", () => {
  it("holds no host authority of any kind", () => {
    for (const mount of manifest.bindMounts) {
      expect(mount.source).not.toBe("@docker-socket");
      expect(mount.target).not.toContain("docker.sock");
      expect(mount.source).not.toContain("DOCKER_CONFIG_DIR");
      expect(mount.target).not.toContain("/.docker");
      // The host repository checkout is what ops-agent alone may hold.
      expect(mount.source).not.toContain("OPENMAPX_HOST_DIR");
    }
    expect(manifest.container.privileged).toBeUndefined();
    expect(manifest.container.networkMode).toBeUndefined();
    expect(manifest.container.capDrop).toEqual(["ALL"]);
    // No Docker client is even installed, so a future manifest slip cannot
    // silently become daemon access.
    expect(dockerfile).not.toContain("docker-cli");
    expect(dockerfile).not.toMatch(/docker-compose|cli-plugins/);
  });

  it("mounts the catalog read-only apart from its output directories", () => {
    const byTarget = new Map(manifest.bindMounts.map((mount) => [mount.target, mount]));
    // The checkout itself — feeds, scripts, pinned git metadata — is immutable.
    expect(byTarget.get("/data/.transitous-catalog")?.readOnly).toBe(true);
    // The catalog's `out` and `downloads` entries are symlinks into these two
    // directories, which is where upstream scripts are allowed to write.
    expect(byTarget.get("/data/gtfs")?.readOnly).toBe(false);
    expect(byTarget.get("/data/.transitous-downloads")?.readOnly).toBe(false);
    expect(byTarget.get("/staging")?.readOnly).toBe(false);
    // Nothing else under /data is visible: no MOTIS artifacts, no offline
    // packages, no traffic data.
    const dataMounts = manifest.bindMounts
      .map((mount) => mount.target)
      .filter((target) => target.startsWith("/data/"));
    expect(dataMounts.sort()).toEqual([
      "/data/.transitous-catalog",
      "/data/.transitous-downloads",
      "/data/gtfs",
    ]);
    for (const mount of manifest.bindMounts) {
      if (mount.target.startsWith("/run/secrets") || mount.target.startsWith("/secrets")) {
        expect(mount.readOnly).toBe(true);
      }
    }
  });

  it("is reachable only from inside the stack", () => {
    // No exposure block at all: no Traefik route, no published host port.
    expect(manifest.exposure).toBeUndefined();
    expect(manifest.communityNetworkAccess).toBeUndefined();
  });

  it("carries no platform secret beyond the feed-decryption key", () => {
    const environment = manifest.container.environment ?? {};
    for (const [name, value] of Object.entries(environment)) {
      // Every value is a literal path or port owned by this manifest — no
      // `${...}` interpolation pulls a stack credential into the container.
      expect(value, name).not.toMatch(/\$\{/);
    }
    const secretish = Object.keys(environment).filter((name) =>
      /PASSWORD|TOKEN|SECRET|DATABASE_URL|REDIS/.test(name),
    );
    expect(secretish).toEqual([]);
    expect(environment.TRANSITOUS_FEED_PROXY_KEY_FILE).toBe("/secrets/transitous-feed-proxy.age");
  });

  it("ships a fixed entrypoint the manifest cannot override", () => {
    // The image's CMD is the server; the manifest supplies neither a command
    // nor an entrypoint, so a compose render cannot repoint it at a shell.
    expect(manifest.container.command).toBeUndefined();
    expect(manifest.container.entrypoint).toBeUndefined();
    expect(dockerfile).toContain('CMD ["node", "--import", "tsx/esm", "dist/index.js"]');
    expect(dockerfile).toMatch(/^USER transitous:transitous$/m);
  });

  it("installs upstream Python from the same pinned, hash-checked lock", () => {
    expect(dockerfile).toContain(
      "COPY services/motis/tools/transitous/requirements.txt /tmp/transitous-requirements.txt",
    );
    expect(dockerfile).toContain("pip3 install --no-cache-dir --require-hashes");
  });
});
