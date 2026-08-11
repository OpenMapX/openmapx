import { AUTH_LEVELS, type AuthLevel } from "../../src/utils/route-auth.js";
import type { IntegrationRouteDescriptor } from "./collect-integration-routes.js";

export { AUTH_LEVELS, type AuthLevel };

export interface CoreRouteEntry {
  method: string;
  url: string;
  auth: AuthLevel;
}

export interface BuildDocumentInput {
  /** `paths` as emitted by @fastify/swagger for the core route table. */
  corePaths: Record<string, Record<string, unknown>>;
  /** Auth classification per core route, collected from Fastify's `onRoute` hook. */
  coreAuth: CoreRouteEntry[];
  integrationRoutes: IntegrationRouteDescriptor[];
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; description: string; version: string };
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const TAG_DESCRIPTIONS: Record<string, string> = {
  admin: "Operator-facing administration of integrations, services, settings and jobs.",
  "data-manager": "Transit, POI and Overture data pipeline control.",
  integrations: "Routes contributed by integrations under /api/integrations/<id>.",
  internal: "Endpoints for other OpenMapX processes, not for clients.",
  meta: "Process-level endpoints: health and registry dumps.",
  auth: "Authentication and OAuth endpoints served by Better Auth.",
};

/** Fastify's `:param` and `*` syntax rewritten to OpenAPI path templates. */
export function toOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      // `{*}` is what @fastify/swagger emits for a Fastify wildcard; `*` is the
      // raw form the integration registry stores.
      if (segment === "*" || segment === "{*}") return "{wildcard}";
      // Per-parameter rather than per-segment: a segment can mix a parameter
      // with literal text, as in `:y.png`.
      return segment.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}");
    })
    .join("/");
}

/** Groups an operation in the rendered document. Derived from the URL, so no route needs to declare one. */
export function tagForPath(path: string): string {
  if (path.startsWith("/api/auth") || path.startsWith("/auth/")) return "auth";
  if (path === "/health") return "meta";
  if (!path.startsWith("/api/")) return "meta";

  const segment = path.slice("/api/".length).split("/")[0] ?? "";
  if (segment === "" || segment.startsWith("{")) return "meta";
  if (segment === "id-schemes") return "meta";
  return segment;
}

function toOperationId(method: string, path: string): string {
  const words = path
    .replace(/\{wildcard\}/g, "wildcard")
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const suffix = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  return `${method.toLowerCase()}${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
}

/** Path parameters OpenAPI requires to be declared, derived from the templated path. */
function pathParameters(path: string): Record<string, unknown>[] {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    ...(name === "wildcard"
      ? { description: "Matches the remainder of the path, including slashes." }
      : {}),
  }));
}

function sortObject<T>(input: Record<string, T>, order?: readonly string[]): Record<string, T> {
  const keys = Object.keys(input);
  keys.sort((a, b) => {
    if (order) {
      const rankA = order.indexOf(a);
      const rankB = order.indexOf(b);
      if (rankA !== -1 || rankB !== -1) {
        if (rankA === -1) return 1;
        if (rankB === -1) return -1;
        if (rankA !== rankB) return rankA - rankB;
      }
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const sorted: Record<string, T> = {};
  for (const key of keys) sorted[key] = input[key] as T;
  return sorted;
}

function authFor(entries: Map<string, AuthLevel>, method: string, path: string): AuthLevel {
  return entries.get(`${method.toUpperCase()} ${path}`) ?? "unspecified";
}

/**
 * Merges the two halves of the API surface into one OpenAPI 3.1 document.
 *
 * Output must be byte-stable for identical input: the committed document is
 * diffed in CI, so any incidental ordering would produce phantom changes.
 */
export function buildDocument(input: BuildDocumentInput): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  // Keyed on the templated path: the auth entries carry Fastify's `:id` form
  // while @fastify/swagger has already rewritten its paths to `{id}`.
  const coreAuthIndex = new Map<string, AuthLevel>();
  for (const entry of input.coreAuth) {
    coreAuthIndex.set(`${entry.method.toUpperCase()} ${toOpenApiPath(entry.url)}`, entry.auth);
  }

  for (const [rawPath, pathItem] of Object.entries(input.corePaths)) {
    const path = toOpenApiPath(rawPath);
    const operations: Record<string, unknown> = paths[path] ?? {};

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const base = (operation ?? {}) as Record<string, unknown>;
      operations[method] = sortObject({
        ...base,
        operationId: toOperationId(method, path),
        tags: [tagForPath(rawPath)],
        "x-openmapx-auth": authFor(coreAuthIndex, method, path),
      });
    }

    if (Object.keys(operations).length > 0) paths[path] = operations;
  }

  for (const route of input.integrationRoutes) {
    const base = `/api/integrations/${route.integrationId}`;
    const rawPath = route.routePath === "/" ? base : `${base}${route.routePath}`;
    const path = toOpenApiPath(rawPath);
    const method = route.method.toLowerCase();
    const parameters = pathParameters(path);

    const operations = paths[path] ?? {};
    operations[method] = sortObject({
      operationId: toOperationId(method, path),
      tags: ["integrations"],
      summary: `${route.method} ${route.routePath} (${route.integrationId})`,
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: { default: { description: "Integration response" } },
      "x-openmapx-auth": route.requireAuth ? "session" : "public",
      "x-openmapx-integration": route.integrationId,
      "x-openmapx-source": route.sourceFile,
    });
    paths[path] = operations;
  }

  const usedTags = new Set<string>();
  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      for (const tag of (operation as { tags?: string[] }).tags ?? []) usedTags.add(tag);
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenMapX API",
      description:
        "Generated from the API's own route table and the integration route registry. " +
        "Do not edit by hand — run `pnpm openapi:generate`.",
      version: "1.0.0",
    },
    tags: [...usedTags].sort().map((name) => ({
      name,
      description: TAG_DESCRIPTIONS[name] ?? `Routes under /api/${name}.`,
    })),
    paths: sortObject(
      Object.fromEntries(
        Object.entries(paths).map(([path, operations]) => [
          path,
          sortObject(operations, HTTP_METHODS),
        ]),
      ),
    ),
  };
}

/** Stable on-disk form: 2-space indent and a trailing newline, matching the repo's JSON formatting. */
export function serializeDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
