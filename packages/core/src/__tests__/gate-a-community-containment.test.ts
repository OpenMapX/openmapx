import { describe, expect, it } from "vitest";
import { renderCompose } from "../services/compose-renderer";
import { checkManifestSandbox } from "../services/sandbox-policy";
import type { LoadedService, ServiceManifest } from "../services/types";

/**
 * Gate A — community containment (Tracks 1–3).
 *
 * One manifest attempts every capability the community boundary forbids at
 * once: a platform-origin proxy route, a host bind mount, Compose
 * interpolation, platform-network membership, and reachability of the
 * platform's data services. The deployment gate is that installation is
 * refused BEFORE any registry or filesystem mutation.
 *
 * The per-capability tests below stay separate on purpose: with a single
 * combined assertion, one rejection firing first would mask the fact that
 * another guard had regressed.
 */

const COMMUNITY = { firstParty: false } as const;
const FIRST_PARTY = { firstParty: true } as const;

function communityManifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return {
    id: "community-weather",
    name: "Community Weather",
    quality: "community",
    container: {
      image: "ghcr.io/example/community-weather",
      digest: `sha256:${"a".repeat(64)}`,
      expose: [8080],
    },
    ...overrides,
  } as ServiceManifest;
}

describe("Gate A — community containment", () => {
  it("refuses a manifest that attempts every forbidden capability at once", () => {
    const hostile = communityManifest({
      exposure: { proxy: { enabled: true, pathPrefix: "/weather" } },
      bindMounts: [{ source: "/etc", target: "/host-etc", readOnly: false }],
      container: {
        image: "ghcr.io/example/community-weather",
        digest: `sha256:${"a".repeat(64)}`,
        expose: [8080],
        networkMode: "host",
        privileged: true,
        environment: { LEAK: "${REDIS_PASSWORD}" },
      },
      communityNetworkAccess: ["openmapx"],
    } as unknown as Partial<ServiceManifest>);

    const errors = checkManifestSandbox(hostile, COMMUNITY);

    // Every attempted capability is independently reported, so a single
    // rejection cannot hide the others.
    expect(errors.length).toBeGreaterThanOrEqual(4);
    const joined = errors.join("\n");
    expect(joined).toMatch(/networkMode/i);
    expect(joined).toMatch(/privileged/i);
    expect(joined).toMatch(/communityNetworkAccess|community_network_access_forbidden/i);
    expect(joined).toMatch(/bind|mount/i);
  });

  it("rejects a platform-origin proxy route on a community service", () => {
    const errors = checkManifestSandbox(
      communityManifest({ exposure: { proxy: { enabled: true, pathPrefix: "/weather" } } }),
      COMMUNITY,
    );
    expect(errors.join("\n")).toMatch(/proxy/i);
  });

  it("rejects a host bind mount on a community service", () => {
    const errors = checkManifestSandbox(
      communityManifest({
        bindMounts: [{ source: "/etc", target: "/host-etc", readOnly: false }],
      } as unknown as Partial<ServiceManifest>),
      COMMUNITY,
    );
    expect(errors.join("\n")).toMatch(/bind|mount/i);
  });

  it("rejects platform-network membership on a community service", () => {
    const errors = checkManifestSandbox(
      communityManifest({
        communityNetworkAccess: ["openmapx"],
      } as unknown as Partial<ServiceManifest>),
      COMMUNITY,
    );
    expect(errors.join("\n")).toMatch(/communityNetworkAccess|community_network_access_forbidden/i);
  });

  it("rejects host networking and privileged execution on a community service", () => {
    const errors = checkManifestSandbox(
      communityManifest({
        container: {
          image: "ghcr.io/example/community-weather",
          digest: `sha256:${"a".repeat(64)}`,
          expose: [8080],
          networkMode: "host",
          privileged: true,
        },
      } as unknown as Partial<ServiceManifest>),
      COMMUNITY,
    );
    const joined = errors.join("\n");
    expect(joined).toMatch(/networkMode/i);
    expect(joined).toMatch(/privileged/i);
  });

  it("still permits the same capabilities for an audited first-party manifest", () => {
    // The boundary keys on provenance, not on a self-declared label — otherwise
    // a community manifest could claim its way across it.
    const firstParty = communityManifest({
      quality: "built-in",
      communityNetworkAccess: ["openmapx"],
    } as unknown as Partial<ServiceManifest>);
    expect(checkManifestSandbox(firstParty, FIRST_PARTY)).toEqual([]);
  });

  it("never renders a Traefik label or resolvable interpolation for a community service", () => {
    const community: LoadedService = {
      manifest: communityManifest({
        container: {
          image: "ghcr.io/example/community-weather",
          digest: `sha256:${"a".repeat(64)}`,
          expose: [8080],
          environment: { LEAK: "${REDIS_PASSWORD}", ALSO: "$REDIS_PASSWORD" },
        },
      } as unknown as Partial<ServiceManifest>),
      directory: "/tmp/community-weather",
      isBuiltIn: false,
      enabled: true,
    };

    const rendered = renderCompose([community], { domain: "maps.example.test" }).composeYaml;

    // No platform route.
    expect(rendered).not.toMatch(/traefik\./);

    // Interpolation is neutralized by doubling the dollar sign, which Compose
    // renders as a literal. What must not appear is a RESOLVABLE reference —
    // a `$` that is not itself escaped by another `$`.
    expect(rendered).not.toMatch(/(?<!\$)\$\{REDIS_PASSWORD\}/);
    expect(rendered).not.toMatch(/(?<!\$)\$REDIS_PASSWORD\b/);
    expect(rendered).toContain("$${REDIS_PASSWORD}");

    // The community service joins only its own isolated network, never the
    // platform network where the data services live.
    expect(rendered).toMatch(/openmapx-community-community-weather/);
    const serviceBlock = rendered.slice(rendered.indexOf("community-weather:"));
    const networksBlock = serviceBlock.slice(
      serviceBlock.indexOf("networks:"),
      serviceBlock.indexOf("networks:") + 200,
    );
    expect(networksBlock).not.toMatch(/^\s+- openmapx$/m);
  });
});
