import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../compose-renderer";
import { resolveConsumesDependencies } from "../consumes-dependencies";
import { detectConsumesCycle } from "../resolver";
import type { LoadedService, ServiceConsumes, ServiceProduces } from "../types";

function service(
  id: string,
  produces: ServiceProduces[] = [],
  consumes: ServiceConsumes[] = [],
): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `test/${id}`, tag: "1" },
      produces,
      consumes,
    },
    directory: `/repo/services/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

const base = service("base", [{ type: "osm-pbf", sourceDir: "data/base" }]);
const europe = service("europe", [
  { type: "osm-pbf", instance: "europe", sourceDir: "data/europe" },
]);
const asia = service("asia", [{ type: "osm-pbf", instance: "asia", sourceDir: "data/asia" }]);
const implicit = service("router", [], [{ type: "osm-pbf", mountAt: "/osm" }]);
const explicit = service("router", [], [{ type: "osm-pbf", instance: "europe", mountAt: "/osm" }]);

// Literal expectations deliberately put consumers first in the registry. A
// wrong producer choice must affect ordering, not just a helper's return value.
const cases = [
  {
    name: "default wins over instanced producers",
    services: [implicit, europe, base, asia],
    upstream: ["base"],
    order: ["base", "router", "europe", "asia"],
    sources: ["data/base"],
  },
  {
    name: "explicit instance wins over the default",
    services: [explicit, base, asia, europe],
    upstream: ["europe"],
    order: ["europe", "router", "base", "asia"],
    sources: ["data/europe"],
  },
  {
    name: "one instanced producer is the implicit default",
    services: [implicit, europe],
    upstream: ["europe"],
    order: ["europe", "router"],
    sources: ["data/europe"],
  },
  {
    name: "missing optional explicit instance never falls back to the default",
    services: [
      service(
        "router",
        [],
        [{ type: "osm-pbf", instance: "missing", mountAt: "/osm", required: false }],
      ),
      base,
      europe,
    ],
    upstream: [],
    order: ["router", "base", "europe"],
    sources: [],
  },
  {
    name: "missing optional type has no dependency",
    services: [service("router", [], [{ type: "absent", mountAt: "/osm", required: false }])],
    upstream: [],
    order: ["router"],
    sources: [],
  },
  {
    name: "self-produced data mounts without forming a dependency cycle",
    services: [
      service(
        "router",
        [{ type: "osm-pbf", sourceDir: "data/local" }],
        [{ type: "osm-pbf", mountAt: "/osm" }],
      ),
    ],
    upstream: [],
    order: ["router"],
    sources: ["data/local"],
  },
  {
    name: "two region consumers preserve declared dependency order",
    services: [
      service(
        "router",
        [],
        [
          { type: "osm-pbf", instance: "asia", mountAt: "/asia" },
          { type: "osm-pbf", instance: "europe", mountAt: "/europe" },
        ],
      ),
      europe,
      asia,
    ],
    upstream: ["asia", "europe"],
    order: ["asia", "europe", "router"],
    sources: ["data/asia", "data/europe"],
  },
];

describe.each(cases)(
  "consumes dependency policy: $name",
  ({ services, upstream, order, sources }) => {
    it("resolves upstream service ids", () => {
      const dependencies = resolveConsumesDependencies(services);
      expect([...(dependencies.get("router") ?? [])]).toEqual(upstream);
      expect([...dependencies.keys()]).toEqual(services.map((s) => s.manifest.id));
    });

    it("keeps cycle detection and rendered order/mounts aligned", () => {
      expect(detectConsumesCycle(services)).toBeNull();
      const result = renderCompose(services, { externalProxyNetwork: null });
      const compose = parseYaml(result.composeYaml) as { services: Record<string, unknown> };
      expect(Object.keys(compose.services)).toEqual(order);
      expect(result.hardlinkPlan.map((entry) => entry.source)).toEqual(sources);
    });
  },
);

describe("dependency validation remains with the renderer", () => {
  it.each([
    { name: "separate services", services: [implicit, europe, asia] },
    {
      name: "two instances on one service",
      services: [
        implicit,
        service("regions", [
          ...(europe.manifest.produces ?? []),
          ...(asia.manifest.produces ?? []),
        ]),
      ],
    },
  ])("does not invent an edge for ambiguous $name", ({ services }) => {
    expect([...(resolveConsumesDependencies(services).get("router") ?? [])]).toEqual([]);
    expect(detectConsumesCycle(services)).toBeNull();
    expect(() => renderCompose(services, {})).toThrow(/multiple producer instances/);
  });

  it("reports a required missing producer without inventing a cycle", () => {
    expect(detectConsumesCycle([implicit])).toBeNull();
    expect(() => renderCompose([implicit], {})).toThrow(/no producer is installed/);
    expect(() => renderCompose([explicit, base], {})).toThrow(/no producer with that instance/);
  });

  it.each([
    {
      name: "default",
      services: [base, service("duplicate", [...(base.manifest.produces ?? [])])],
      message: /Multiple default-instance producers/,
    },
    {
      name: "instance",
      services: [europe, service("duplicate", [...(europe.manifest.produces ?? [])])],
      message: /Multiple producers for/,
    },
  ])("keeps the duplicate $name producer diagnostic", ({ services, message }) => {
    expect(detectConsumesCycle(services)).toBeNull();
    expect(() => renderCompose(services, {})).toThrow(message);
  });
});

describe("instance-aware cycles", () => {
  const router = service(
    "router",
    [{ type: "graph", sourceDir: "data/graph" }],
    [{ type: "osm-pbf", instance: "europe", mountAt: "/osm" }],
  );
  const regionalCycle = service(
    "europe",
    [...(europe.manifest.produces ?? [])],
    [{ type: "graph", mountAt: "/graph" }],
  );

  it("detects the selected region cycle and rejects Compose output", () => {
    expect(detectConsumesCycle([router, asia, regionalCycle])?.sort()).toEqual([
      "europe",
      "router",
    ]);
    expect(() => renderCompose([router, asia, regionalCycle], {})).toThrow(/Cycle detected/);
  });

  it("does not follow the unselected region into a false cycle", () => {
    const services = [
      service(
        "router",
        [...(router.manifest.produces ?? [])],
        [{ type: "osm-pbf", instance: "asia", mountAt: "/osm" }],
      ),
      regionalCycle,
      asia,
    ];
    expect(detectConsumesCycle(services)).toBeNull();
    const compose = parseYaml(renderCompose(services, {}).composeYaml) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(compose.services)).toEqual(["asia", "router", "europe"]);
  });

  it("preserves cycle-before-duplicate error precedence", () => {
    const duplicate = service("duplicate", [...(asia.manifest.produces ?? [])]);
    expect(() => renderCompose([router, regionalCycle, asia, duplicate], {})).toThrow(
      /Cycle detected/,
    );
  });
});
