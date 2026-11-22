import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  buildApiServiceEnv,
  type LoadedService,
  renderCompose,
  renderTraefikDynamicConfiguration,
  renderTraefikDynamicYaml,
  resolveProxyHost,
  ServiceRegistry,
} from "../services";
import { EXTERNAL_PROXY_NETWORK_KEY } from "../services/external-proxy";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const DOMAIN = "example.com";

interface RenderedService {
  networks?: Record<string, { aliases?: string[] } | null>;
  environment?: Record<string, string>;
  command?: string[] | string;
  healthcheck?: { test?: string[] | string };
}

function community(id: string, environment: Record<string, string> = {}): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "community",
      container: {
        image: `registry.example.test/${id}`,
        tag: "1",
        expose: [4100],
        memory: "256m",
        environment,
      },
    },
    directory: `/community/${id}`,
    isBuiltIn: false,
    enabled: true,
  };
}

/**
 * Every built-in, enabled, plus the community services a built-in bridges to,
 * rendered behind an operator-run proxy: the layout where a bare service ID
 * could resolve to another project's container on the shared network.
 */
async function renderBehindExternalProxy() {
  const registry = new ServiceRegistry({ rootDir: repoRoot });
  await registry.load();
  const builtIns = registry
    .list()
    .filter((service) => service.manifest.id !== "traefik")
    .map((service) => ({ ...service, enabled: true }));
  const services = [
    ...builtIns,
    community("openconditions-ingest", {
      DATABASE_URL: "postgresql://ingest@openmapx-postgis:5432/openmapx",
    }),
    community("openconditions-contributions-api"),
  ];
  const { composeYaml } = renderCompose(services, {
    domain: DOMAIN,
    externalProxyNetwork: "shared-proxy",
    allServices: services,
  });
  return {
    services,
    rendered: (parseYaml(composeYaml) as { services: Record<string, RenderedService> }).services,
  };
}

describe("project-unique service names", () => {
  it("gives every service exactly its openmapx-<id> name on each internal network, never on the shared proxy network", async () => {
    const { services, rendered } = await renderBehindExternalProxy();
    expect(Object.keys(rendered).sort()).toEqual(
      services.map((service) => service.manifest.id).sort(),
    );
    let joinedProxy = 0;
    for (const [id, service] of Object.entries(rendered)) {
      const networks = Object.entries(service.networks ?? {});
      expect(networks.length, id).toBeGreaterThan(0);
      for (const [network, attachment] of networks) {
        if (network === EXTERNAL_PROXY_NETWORK_KEY) {
          joinedProxy += 1;
          expect(attachment?.aliases, `${id} on the shared proxy network`).toBeUndefined();
        } else {
          expect(attachment?.aliases, `${id} on ${network}`).toEqual([`openmapx-${id}`]);
        }
      }
    }
    // The routed services (api, web, martin, …) are the ones that join it.
    expect(joinedProxy).toBeGreaterThan(3);
  });

  it("points no rendered internal address at a bare service ID", async () => {
    const { services, rendered } = await renderBehindExternalProxy();
    const ids = new Set(services.map((service) => service.manifest.id));
    const values: [string, string][] = [];
    for (const [id, service] of Object.entries(rendered)) {
      for (const [key, value] of Object.entries(service.environment ?? {}))
        values.push([`${id} ${key}`, String(value)]);
      for (const value of [service.command ?? [], service.healthcheck?.test ?? []].flat())
        values.push([`${id} command`, value]);
    }
    // The API's generated environment: defaults for the backends it reads from env.
    for (const [key, value] of Object.entries(buildApiServiceEnv(services)))
      values.push([`api generated ${key}`, String(value)]);
    const traefik = renderTraefikDynamicYaml(
      renderTraefikDynamicConfiguration(
        services.filter((service) => service.isBuiltIn).map((service) => service.manifest),
        {
          domain: DOMAIN,
          resolveProxyHost: (manifest) => resolveProxyHost(manifest, { domain: DOMAIN }),
        },
      ),
    );
    values.push(["traefik file provider", traefik]);

    const bare: string[] = [];
    const unknown: string[] = [];
    for (const [where, value] of values) {
      const hosts = [...value.matchAll(/(?:\/\/|@)([a-z0-9][a-z0-9.-]*)(?=[:/]|$)/g)].map(
        (match) => match[1] ?? "",
      );
      if (where.endsWith("_HOST")) hosts.push(value);
      for (const host of hosts) {
        if (ids.has(host)) bare.push(`${where}: ${host}`);
        // A unique name must name a service of this stack.
        if (host.startsWith("openmapx-") && !ids.has(host.slice("openmapx-".length)))
          unknown.push(`${where}: ${host}`);
      }
    }
    expect(bare).toEqual([]);
    expect(unknown).toEqual([]);
    // The scan sees the internal addresses it is meant to judge.
    expect(values.map(([, value]) => value).join("\n")).toContain("@openmapx-postgis:5432");
  });
});
