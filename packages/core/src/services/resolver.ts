import type { IntegrationRequirement, LoadedService, ResolutionResult } from "./types";

export function findByCapability(services: LoadedService[], capability: string): LoadedService[] {
  return services.filter((s) => s.enabled && s.manifest.provides?.includes(capability));
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
 */
export function detectConsumesCycle(services: LoadedService[]): string[] | null {
  const producers = new Map<string, string>(); // dataType -> serviceId
  for (const s of services) {
    for (const p of s.manifest.produces ?? []) {
      producers.set(p.type, s.manifest.id);
    }
  }

  const adj = new Map<string, string[]>(); // serviceId -> downstream ids it consumes from
  for (const s of services) {
    const deps: string[] = [];
    for (const c of s.manifest.consumes ?? []) {
      const producer = producers.get(c.type);
      if (producer) deps.push(producer);
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
