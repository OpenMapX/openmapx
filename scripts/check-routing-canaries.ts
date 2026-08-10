/**
 * Stable, invariant-based smoke checks for the public directions endpoint.
 *
 * The checks deliberately avoid historical exact route counts: Valhalla may
 * return fewer valid alternatives for a particular graph, traffic snapshot,
 * or costing profile. A short control route must return at least one alternate;
 * a longer regression route must still return a primary route. Every returned
 * motorised route must carry a finite baseline duration, but baseline is not
 * required to be <= live duration — unusually light live traffic can reverse
 * that relationship.
 *
 * Run with:
 *   pnpm check-routing-canaries
 *
 * Override ROUTING_BASE_URL to probe another deployment.
 */

export interface RoutingCanaryRoute {
  duration?: unknown;
  baselineDuration?: unknown;
  distance?: unknown;
}

export interface RoutingCanaryResponse {
  routes?: unknown;
}

export interface RoutingCanary {
  name: string;
  waypoints: string;
  minimumRoutes: number;
  requireBaseline: boolean;
}

export const ROUTING_CANARIES: readonly RoutingCanary[] = [
  {
    name: "Aachen → Orsoy (short alternate control)",
    waypoints: "6.0839,50.7753;6.6833,51.5167",
    minimumRoutes: 2,
    requireBaseline: true,
  },
  {
    name: "Aachen → Berlin (long-route regression control)",
    waypoints: "6.0839,50.7753;13.4050,52.5200",
    minimumRoutes: 1,
    requireBaseline: true,
  },
];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function routesFromResponse(response: RoutingCanaryResponse): RoutingCanaryRoute[] | null {
  if (!Array.isArray(response.routes)) return null;
  return response.routes.map((route) =>
    route && typeof route === "object" ? (route as RoutingCanaryRoute) : {},
  );
}

export function validateRoutingCanary(
  canary: RoutingCanary,
  response: RoutingCanaryResponse,
): string[] {
  const errors: string[] = [];
  const routes = routesFromResponse(response);

  if (!routes) {
    return [`${canary.name}: response did not contain a routes array`];
  }
  if (routes.length < canary.minimumRoutes) {
    errors.push(
      `${canary.name}: expected at least ${canary.minimumRoutes} route(s), received ${routes.length}`,
    );
  }

  if (canary.requireBaseline) {
    routes.forEach((route, index) => {
      if (!isFiniteNonNegative(route.duration)) {
        errors.push(`${canary.name}: route ${index + 1} has no finite live duration`);
      }
      if (!isFiniteNonNegative(route.baselineDuration)) {
        errors.push(`${canary.name}: route ${index + 1} has no finite baseline duration`);
      }
    });
  }

  return errors;
}

async function runCanary(baseUrl: string, canary: RoutingCanary): Promise<string[]> {
  const url = new URL("/api/integrations/routing/directions", baseUrl);
  url.searchParams.set("waypoints", canary.waypoints);
  url.searchParams.set("mode", "driving");

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    return [`${canary.name}: request failed — ${(error as Error).message}`];
  }

  let body: RoutingCanaryResponse;
  try {
    body = (await response.json()) as RoutingCanaryResponse;
  } catch {
    return [`${canary.name}: endpoint returned non-JSON HTTP ${response.status}`];
  }

  const errors = response.ok
    ? validateRoutingCanary(canary, body)
    : [`${canary.name}: endpoint returned HTTP ${response.status}`];
  const routes = routesFromResponse(body) ?? [];
  const durationMs = Math.round(performance.now() - startedAt);
  const routeSummary = routes
    .map((route) => `${String(route.distance ?? "?")}m/${String(route.duration ?? "?")}s`)
    .join(", ");
  console.log(
    `${canary.name}: ${routes.length} route(s) in ${durationMs}ms${routeSummary ? ` — ${routeSummary}` : ""}`,
  );
  return errors;
}

async function main(): Promise<void> {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone probe intentionally accepts a caller-supplied deployment URL.
  const baseUrl = process.env.ROUTING_BASE_URL ?? "https://openmapx.com";
  const errors = (
    await Promise.all(ROUTING_CANARIES.map((canary) => runCanary(baseUrl, canary)))
  ).flat();
  if (errors.length > 0) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Routing canaries passed: alternate availability and baseline fields are healthy.");
}

if (process.argv[1]?.endsWith("check-routing-canaries.ts")) {
  void main().catch(() => {
    console.error("✗ Routing canary runner failed unexpectedly");
    process.exitCode = 1;
  });
}
