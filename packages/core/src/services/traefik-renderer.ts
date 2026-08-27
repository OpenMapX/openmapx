import { dump as yamlDump } from "js-yaml";
import type { ServiceManifest } from "./types";

// Generated Traefik dynamic (file-provider) configuration.
//
// Traefik previously discovered routes by reading the Docker socket, which gave
// the reverse proxy — an internet-facing component — full host authority. It now
// reads a generated file instead. The file is produced from the same validated,
// enabled, first-party manifests the Compose renderer uses, so the routing
// surface is identical while the socket is gone.
//
// Community services never receive a platform route (Track 1); only first-party
// manifests are rendered here.

export interface TraefikRouter {
  rule: string;
  entryPoints: string[];
  service: string;
  middlewares?: string[];
  priority?: number;
  tls: { certResolver: string };
}

export interface TraefikService {
  loadBalancer: { servers: Array<{ url: string }> };
}

export interface TraefikMiddleware {
  stripPrefix?: { prefixes: string[] };
}

export interface TraefikDynamicConfiguration {
  http: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
    middlewares: Record<string, TraefikMiddleware>;
  };
}

export interface TraefikRenderContext {
  domain?: string;
  /** Resolves a manifest's proxy hostname exactly as the Compose renderer does. */
  resolveProxyHost: (manifest: ServiceManifest) => string | undefined;
}

/**
 * Render the dynamic configuration for one manifest, or null when it declares
 * no proxy. The router names, rules, entrypoints, priorities, middlewares, and
 * backend ports intentionally mirror `renderTraefikLabels` one-for-one — the
 * golden parity test asserts that equivalence for every built-in proxied
 * service, so switching providers cannot silently change routing.
 */
export function renderTraefikServiceConfiguration(
  manifest: ServiceManifest,
  ctx: TraefikRenderContext,
): TraefikDynamicConfiguration | null {
  const proxy = manifest.exposure?.proxy;
  if (!proxy?.enabled) return null;

  const id = manifest.id;
  const customHost = ctx.resolveProxyHost(manifest);
  const domain = customHost ?? ctx.domain ?? "localhost";
  const pathPrefix = proxy.pathPrefix ?? (customHost ? undefined : `/${id}`);
  const targetPort = manifest.container.expose?.[0] ?? 80;

  const routers: Record<string, TraefikRouter> = {};
  const middlewares: Record<string, TraefikMiddleware> = {};

  const routerMiddlewares: string[] = [];
  if (proxy.stripPrefix) {
    if (!pathPrefix) throw new Error(`stripPrefix requires a pathPrefix for service "${id}"`);
    middlewares[`${id}-strip`] = { stripPrefix: { prefixes: [pathPrefix] } };
    routerMiddlewares.push(`${id}-strip`);
  }
  for (const middleware of proxy.middleware ?? []) routerMiddlewares.push(middleware);

  routers[id] = {
    rule: pathPrefix
      ? `Host(\`${domain}\`) && PathPrefix(\`${pathPrefix}\`)`
      : `Host(\`${domain}\`)`,
    entryPoints: ["websecure"],
    service: id,
    ...(routerMiddlewares.length > 0 ? { middlewares: routerMiddlewares } : {}),
    ...(typeof proxy.priority === "number" ? { priority: proxy.priority } : {}),
    tls: { certResolver: "letsencrypt" },
  };

  // Additional routes each get their own router but share the one backend, so a
  // service exposing both `/api/*` and `/health` still hits a single container
  // port — the same behaviour the labels produced.
  const additionalRoutes = proxy.additionalRoutes ?? [];
  for (let index = 0; index < additionalRoutes.length; index += 1) {
    const route = additionalRoutes[index];
    if (!route) continue;
    const routerName = `${id}-r${index + 1}`;
    const matcher = route.path ? `Path(\`${route.path}\`)` : `PathPrefix(\`${route.pathPrefix}\`)`;
    routers[routerName] = {
      rule: `Host(\`${domain}\`) && ${matcher}`,
      entryPoints: ["websecure"],
      service: id,
      ...(route.middleware?.length ? { middlewares: [...route.middleware] } : {}),
      tls: { certResolver: "letsencrypt" },
    };
  }

  return {
    http: {
      routers,
      // The container name is the Docker-network hostname the socket provider
      // used to discover; naming it explicitly is what removes the need for it.
      services: {
        [id]: {
          loadBalancer: {
            servers: [{ url: `http://${manifest.container.containerName ?? id}:${targetPort}` }],
          },
        },
      },
      middlewares,
    },
  };
}

/**
 * Merge every enabled first-party manifest into one dynamic configuration with
 * deterministic ordering, so the generated file only changes when routing does.
 */
export function renderTraefikDynamicConfiguration(
  manifests: readonly ServiceManifest[],
  ctx: TraefikRenderContext,
): TraefikDynamicConfiguration {
  const merged: TraefikDynamicConfiguration = {
    http: { routers: {}, services: {}, middlewares: {} },
  };
  const ordered = [...manifests].sort((left, right) => (left.id < right.id ? -1 : 1));
  for (const manifest of ordered) {
    const rendered = renderTraefikServiceConfiguration(manifest, ctx);
    if (!rendered) continue;
    for (const [name, router] of Object.entries(rendered.http.routers)) {
      if (merged.http.routers[name]) {
        throw new Error(`Duplicate Traefik router name "${name}"`);
      }
      merged.http.routers[name] = router;
    }
    for (const [name, service] of Object.entries(rendered.http.services)) {
      if (merged.http.services[name]) {
        throw new Error(`Duplicate Traefik service name "${name}"`);
      }
      merged.http.services[name] = service;
    }
    for (const [name, middleware] of Object.entries(rendered.http.middlewares)) {
      if (merged.http.middlewares[name]) {
        throw new Error(`Duplicate Traefik middleware name "${name}"`);
      }
      merged.http.middlewares[name] = middleware;
    }
  }
  return merged;
}

/**
 * Serialize the dynamic configuration for Traefik's file provider. Keys are
 * sorted so the generated file only changes when routing actually changes.
 */
export function renderTraefikDynamicYaml(config: TraefikDynamicConfiguration): string {
  return `# Generated by \`openmapx compose render\` — do not edit.\n${yamlDump(config, {
    lineWidth: -1,
    sortKeys: true,
  })}`;
}
