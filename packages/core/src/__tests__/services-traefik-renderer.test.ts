import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose, resolveProxyHost } from "../services/compose-renderer";
import { findServiceManifestDirs } from "../services/manifest-discovery";
import { serviceManifestSchema } from "../services/manifest-schema";
import {
  renderTraefikDynamicConfiguration,
  renderTraefikServiceConfiguration,
} from "../services/traefik-renderer";
import type { LoadedService, ServiceManifest } from "../services/types";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DOMAIN = "maps.example.test";

function loadBuiltIns(): LoadedService[] {
  return findServiceManifestDirs(join(REPO_ROOT, "services")).map((directory) => ({
    // The Zod-inferred shape is wider than the hand-written interface for a
    // couple of optional fields; the manifest is already validated here.
    manifest: serviceManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
    ) as unknown as ServiceManifest,
    directory,
    isBuiltIn: true,
    enabled: true,
  }));
}

/**
 * Labels for every proxied built-in, taken from one render of the whole stack:
 * rendering a single service in isolation fails its `consumes` resolution.
 */
function labelsByService(): Map<string, Record<string, string>> {
  const loaded = loadBuiltIns();
  const compose = renderCompose(loaded, { domain: DOMAIN });
  const rendered = (parseYaml(compose.composeYaml) as { services: Record<string, unknown> })
    .services as Record<string, { labels?: Record<string, string> }>;
  const out = new Map<string, Record<string, string>>();
  for (const entry of loaded) {
    if (entry.manifest.exposure?.proxy?.enabled !== true) continue;
    out.set(entry.manifest.id, rendered[entry.manifest.id]?.labels ?? {});
  }
  return out;
}

/**
 * Reconstruct the router/service/middleware view the Docker-label provider
 * produced, so the generated file configuration can be compared against it.
 */
function routingFromLabels(labels: Record<string, string>) {
  const routers: Record<string, Record<string, string>> = {};
  const services: Record<string, string> = {};
  const middlewares: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    let match = /^traefik\.http\.routers\.([^.]+)\.(.+)$/.exec(key);
    if (match) {
      const name = match[1] as string;
      routers[name] ??= {};
      (routers[name] as Record<string, string>)[match[2] as string] = value;
      continue;
    }
    match = /^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/.exec(key);
    if (match) {
      services[match[1] as string] = value;
      continue;
    }
    match = /^traefik\.http\.middlewares\.([^.]+)\.stripprefix\.prefixes$/.exec(key);
    if (match) middlewares[match[1] as string] = value;
  }
  return { routers, services, middlewares };
}

describe("generated Traefik file configuration", () => {
  const labelSets = labelsByService();
  const manifests = loadBuiltIns()
    .map((entry) => entry.manifest)
    .filter((manifest) => manifest.exposure?.proxy?.enabled === true);

  it("finds proxied built-in services to compare", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests.map((manifest) => [manifest.id, manifest] as const))(
    "reaches label parity for %s",
    (_id, manifest) => {
      const expected = routingFromLabels(labelSets.get(manifest.id) ?? {});

      const generated = renderTraefikServiceConfiguration(manifest, {
        domain: DOMAIN,
        resolveProxyHost: (candidate) => resolveProxyHost(candidate, { domain: DOMAIN }),
      });
      expect(generated).not.toBeNull();
      const actual = generated as NonNullable<typeof generated>;

      // Same router set, same rules, entrypoints, priorities, and middlewares.
      expect(Object.keys(actual.http.routers).sort()).toEqual(Object.keys(expected.routers).sort());
      for (const [name, router] of Object.entries(actual.http.routers)) {
        const labelRouter = expected.routers[name] as Record<string, string>;
        expect(router.rule).toBe(labelRouter.rule);
        expect(router.entryPoints).toEqual([labelRouter.entrypoints]);
        expect(router.tls.certResolver).toBe(labelRouter["tls.certresolver"]);
        expect(router.middlewares?.join(",")).toBe(labelRouter.middlewares);
        expect(router.priority === undefined ? undefined : String(router.priority)).toBe(
          labelRouter.priority,
        );
        // Every router resolves to the one backend the labels declared.
        expect(router.service).toBe(labelRouter.service ?? manifest.id);
      }

      // Same backend port.
      const port = expected.services[manifest.id] as string;
      const server = actual.http.services[manifest.id]?.loadBalancer.servers[0]?.url as string;
      expect(server.endsWith(`:${port}`)).toBe(true);

      // Same strip-prefix middleware definitions.
      expect(Object.keys(actual.http.middlewares).sort()).toEqual(
        Object.keys(expected.middlewares).sort(),
      );
      for (const [name, middleware] of Object.entries(actual.http.middlewares)) {
        expect(middleware.stripPrefix?.prefixes).toEqual([expected.middlewares[name]]);
      }
    },
  );

  it("merges every proxied manifest deterministically and rejects duplicates", () => {
    const first = renderTraefikDynamicConfiguration(manifests, {
      domain: DOMAIN,
      resolveProxyHost: (candidate) => resolveProxyHost(candidate, { domain: DOMAIN }),
    });
    const second = renderTraefikDynamicConfiguration([...manifests].reverse(), {
      domain: DOMAIN,
      resolveProxyHost: (candidate) => resolveProxyHost(candidate, { domain: DOMAIN }),
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const duplicated = manifests[0] as ServiceManifest;
    expect(() =>
      renderTraefikDynamicConfiguration([duplicated, duplicated], {
        domain: DOMAIN,
        resolveProxyHost: (candidate) => resolveProxyHost(candidate, { domain: DOMAIN }),
      }),
    ).toThrow(/Duplicate Traefik router/);
  });

  it("renders nothing for a service that declares no proxy", () => {
    const manifest = { ...(manifests[0] as ServiceManifest), exposure: {} } as ServiceManifest;
    expect(
      renderTraefikServiceConfiguration(manifest, {
        domain: DOMAIN,
        resolveProxyHost: () => undefined,
      }),
    ).toBeNull();
  });
});
