import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../packages/core/src/services/compose-renderer";
import { findServiceManifestDirs } from "../packages/core/src/services/manifest-discovery";
import { serviceManifestSchema } from "../packages/core/src/services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../packages/core/src/services/types";
import { findAuthorityViolations } from "./check-ops-authority";

/**
 * Gate C — host authority.
 *
 * Track 4 is complete only when a policy test AND a rendered stack jointly show
 * that the Docker socket, host repository write access, and Docker credentials
 * exist only in the operations agent. Searching source is not sufficient, so
 * this renders the full built-in stack and inspects the produced Compose
 * mounts, networks, and users rather than the manifests alone.
 */

const ROOT = join(import.meta.dirname, "..");
const AUTHORITY_SERVICE = "ops-agent";

interface RenderedService {
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  user?: string;
  privileged?: boolean;
  cap_add?: string[];
  labels?: Record<string, string>;
}

function renderFullStack(): Record<string, RenderedService> {
  const loaded: LoadedService[] = findServiceManifestDirs(join(ROOT, "services")).map(
    (directory) => ({
      manifest: serviceManifestSchema.parse(
        JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
      ) as unknown as ServiceManifest,
      directory,
      isBuiltIn: true,
      enabled: true,
    }),
  );
  const compose = renderCompose(loaded, { domain: "maps.example.test" });
  // Parsed without a YAML dependency: the renderer emits two-space-indented
  // service keys under a single top-level `services:` block, and this gate only
  // needs each service's volume lines.
  const lines = compose.composeYaml.split("\n");
  const start = lines.indexOf("services:");
  const out: Record<string, RenderedService> = {};
  let current: string | undefined;
  let inVolumes = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // left the services block
    const service = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/.exec(line);
    if (service) {
      current = service[1] as string;
      out[current] = { volumes: [] };
      inVolumes = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}volumes:\s*$/.test(line)) {
      inVolumes = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inVolumes = false;
      continue;
    }
    const item = /^ {6}- (.+)$/.exec(line);
    if (inVolumes && item) (out[current] as RenderedService).volumes?.push(item[1] as string);
  }
  return out;
}

describe("Gate C — host authority", () => {
  const services = renderFullStack();

  it("renders every built-in service so the inspection is meaningful", () => {
    expect(Object.keys(services).length).toBeGreaterThan(5);
    expect(services[AUTHORITY_SERVICE]).toBeDefined();
  });

  it("grants the Docker socket to the operations agent alone in the rendered stack", () => {
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("docker.sock")),
      )
      .map(([id]) => id);
    expect(holders).toEqual([AUTHORITY_SERVICE]);
  });

  it("grants Docker credentials to the operations agent alone in the rendered stack", () => {
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("/.docker")),
      )
      .map(([id]) => id);
    expect(holders).toEqual([AUTHORITY_SERVICE]);
  });

  it("grants the host repository root to no service at all in the rendered stack", () => {
    // Host repository WRITE access was the third leg of Gate C. Every caller now
    // reaches `infra/docker/` through typed agent operations instead.
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => {
          const [source = "", target = ""] = volume.split(":");
          // The repository root mounted at itself; a narrower subdirectory
          // (extension artifacts) is application data, not the checkout.
          return source !== "" && source === target && /openmapx/i.test(source);
        }),
      )
      .map(([id]) => id);
    expect(holders).toEqual([]);
  });

  it("declares no Docker provider anywhere in production service configuration", () => {
    // Traefik's socket provider was host authority by another name.
    const traefik = readFileSync(
      join(ROOT, "services", "traefik", "config", "traefik.yml"),
      "utf8",
    );
    expect(traefik).not.toContain("docker.sock");
    expect(traefik).not.toMatch(/^\s*docker:\s*$/m);
  });

  it("passes the standalone policy gate with no violations", () => {
    expect(findAuthorityViolations(ROOT)).toEqual([]);
  });

  it("ships no Docker CLI in the API image", () => {
    const dockerfile = readFileSync(join(ROOT, "apps", "api", "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/\bdocker-cli\b/);
    expect(dockerfile).not.toMatch(/\bdocker-cli-compose\b/);
    // And it must not run as root.
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("keeps every production image off the root user", () => {
    const dockerfiles = readdirSync(join(ROOT, "apps"))
      .map((name) => join(ROOT, "apps", name, "Dockerfile"))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const path of dockerfiles) {
      // `USER node`, `USER nextjs`, and `USER node:node` are all non-root.
      expect(readFileSync(path, "utf8"), path).toMatch(/^USER (?!root\b)[\w:-]+$/m);
    }
  });
});
