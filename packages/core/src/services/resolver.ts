import {
  getProvidedCapabilityNames,
  type IntegrationRequirement,
  type LoadedService,
  type ResolutionResult,
} from "./types";

export function findByCapability(services: LoadedService[], capability: string): LoadedService[] {
  return services.filter(
    (s) => s.enabled && getProvidedCapabilityNames(s.manifest.provides).includes(capability),
  );
}

export interface ResolverContext {
  bindings?: Map<string, string>;
  gitUrlBySlug?: Map<string, string>;
}

function isGitUrl(value: string): boolean {
  return /^(https?|git|ssh):\/\//.test(value) || value.endsWith(".git");
}

export function resolveRequirement(
  services: LoadedService[],
  req: IntegrationRequirement,
  ctx: ResolverContext = {},
): ResolutionResult {
  if (req.service) {
    if (isGitUrl(req.service)) {
      const slugForUrl = [...(ctx.gitUrlBySlug ?? [])].find(([, url]) => url === req.service)?.[0];
      if (!slugForUrl) {
        return { satisfied: false, reason: "service-not-installed" };
      }
      const svc = services.find((s) => s.manifest.id === slugForUrl);
      if (!svc) return { satisfied: false, reason: "service-not-installed" };
      if (!svc.enabled) return { satisfied: false, reason: "service-disabled" };
      return {
        satisfied: true,
        match: { serviceId: svc.manifest.id, source: "git-url" },
      };
    }

    const svc = services.find((s) => s.manifest.id === req.service);
    if (!svc) return { satisfied: false, reason: "service-not-installed" };
    if (!svc.enabled) return { satisfied: false, reason: "service-disabled" };
    return { satisfied: true, match: { serviceId: svc.manifest.id, source: "exact-service" } };
  }

  if (req.capability) {
    const providers = findByCapability(services, req.capability);
    if (providers.length === 0) {
      return { satisfied: false, reason: "no-providers" };
    }

    const bound = ctx.bindings?.get(req.capability);
    if (bound) {
      const svc = providers.find((p) => p.manifest.id === bound);
      if (svc) {
        return { satisfied: true, match: { serviceId: svc.manifest.id, source: "capability" } };
      }
    }

    if (providers.length === 1) {
      const only = providers[0];
      if (only) {
        return {
          satisfied: true,
          match: { serviceId: only.manifest.id, source: "capability" },
        };
      }
    }

    return {
      satisfied: false,
      reason: "ambiguous",
      candidates: providers.map((p) => p.manifest.id),
    };
  }

  return { satisfied: false, reason: "no-providers" };
}

/**
 * Detect a cycle in the consumes/produces DAG. Returns the set of service ids
 * forming the cycle (any order), or null if acyclic.
 *
 * Producers are indexed by `(type, instance)` so multi-region setups (one
 * service per region producing the same type with different `instance` ids)
 * don't collide. A consumer that omits `instance` resolves to:
 *   1. the default-instance producer for the type, if any, else
 *   2. the only instanced producer for the type, if exactly one exists, else
 *   3. nothing (cycle detection treats it as no dependency — the renderer
 *      will surface the ambiguity at render time).
 */
export function detectConsumesCycle(services: LoadedService[]): string[] | null {
  const defaultProducers = new Map<string, string>(); // type -> serviceId
  const instancedProducers = new Map<string, string>(); // `${type}/${instance}` -> serviceId
  const producersByType = new Map<string, string[]>(); // type -> all producer serviceIds
  for (const s of services) {
    for (const p of s.manifest.produces ?? []) {
      if (p.instance === undefined) {
        defaultProducers.set(p.type, s.manifest.id);
      } else {
        instancedProducers.set(`${p.type}/${p.instance}`, s.manifest.id);
      }
      const list = producersByType.get(p.type) ?? [];
      list.push(s.manifest.id);
      producersByType.set(p.type, list);
    }
  }

  const adj = new Map<string, string[]>(); // serviceId -> upstream ids it consumes from
  for (const s of services) {
    const deps: string[] = [];
    for (const c of s.manifest.consumes ?? []) {
      let producer: string | undefined;
      if (c.instance !== undefined) {
        producer = instancedProducers.get(`${c.type}/${c.instance}`);
      } else {
        producer =
          defaultProducers.get(c.type) ??
          (producersByType.get(c.type)?.length === 1
            ? producersByType.get(c.type)?.[0]
            : undefined);
      }
      // A service that produces AND consumes the same data type (e.g. osrm
      // produces osrm-graph from its buildCommand, then its container consumes
      // the same type) is NOT a cycle — the host-side hardlink apply mediates
      // between source and target. `topologicalOrder` applies the same filter.
      if (producer && producer !== s.manifest.id) deps.push(producer);
    }
    adj.set(s.manifest.id, deps);
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  let cycleStart: string | null = null;
  let cycleEnd: string | null = null;

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      if ((color.get(next) ?? WHITE) === WHITE) {
        parent.set(next, node);
        if (dfs(next)) return true;
      } else if (color.get(next) === GRAY) {
        cycleStart = next;
        cycleEnd = node;
        return true;
      }
    }
    color.set(node, BLACK);
    return false;
  }

  for (const s of services) {
    if ((color.get(s.manifest.id) ?? WHITE) === WHITE) {
      if (dfs(s.manifest.id)) break;
    }
  }

  if (cycleStart === null || cycleEnd === null) return null;

  const start: string = cycleStart;
  const cycle: string[] = [start];
  let cur: string = cycleEnd;
  while (cur !== start) {
    cycle.push(cur);
    const next = parent.get(cur);
    if (next === undefined) break;
    cur = next;
  }
  return cycle;
}
