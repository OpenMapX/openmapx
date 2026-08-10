/**
 * The release guard for OpenStreetMap contributions.
 *
 * Publishing to a public database is opt-in twice over: a master flag and an
 * independent direct-write kill switch, both off unless an operator turns them
 * on. This pins that default in the three places a deployment can inherit it
 * from — the code, the environment examples, and the rendered service manifest
 * — so it cannot drift on accidentally in a future change.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadOsmConfig } from "../../../utils/osm-config.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(`${REPO_ROOT}${relativePath}`, "utf8");
}

const FLAGS = ["OSM_CONTRIBUTIONS_ENABLED", "OSM_DIRECT_EDITING_ENABLED"] as const;

describe("code defaults", () => {
  it("keeps both flags off with no configuration at all", () => {
    const config = loadOsmConfig({});
    expect(config.contributionsEnabled).toBe(false);
    expect(config.directEditingEnabled).toBe(false);
  });

  it("keeps the feature closed when OAuth is unconfigured, whatever the flags say", () => {
    const config = loadOsmConfig({
      OSM_CONTRIBUTIONS_ENABLED: "true",
      OSM_DIRECT_EDITING_ENABLED: "true",
    });
    // The flags parse as on, but without credentials the capability is closed.
    expect(config.contributionsEnabled).toBe(true);
    expect(config.oauthConfigured).toBe(false);
  });

  it("defaults to the production OpenStreetMap instance", () => {
    const config = loadOsmConfig({});
    expect(config.apiBase).toBe("https://api.openstreetmap.org/");
    expect(config.isProductionOsm).toBe(true);
  });
});

describe("environment examples", () => {
  it.each(["apps/api/.env.example", "infra/docker/.env.example"])(
    "%s documents both flags as commented-out false",
    (path) => {
      const contents = read(path);
      for (const flag of FLAGS) {
        expect(contents).toContain(`# ${flag}=false`);
        // Never shipped uncommented, and never shipped as true.
        expect(contents).not.toMatch(new RegExp(`^\\s*${flag}=`, "m"));
        expect(contents).not.toContain(`${flag}=true`);
      }
    },
  );

  it.each(["apps/api/.env.example", "infra/docker/.env.example"])(
    "%s documents the rate limits and the production origins",
    (path) => {
      const contents = read(path);
      for (const limiter of ["READ", "PREVIEW", "PUBLISH", "NOTE"]) {
        expect(contents).toContain(`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_MAX=`);
        expect(contents).toContain(`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_WINDOW_MS=`);
      }
      expect(contents).toContain("# OSM_API_URL=https://api.openstreetmap.org");
      expect(contents).toContain("# OSM_WEB_URL=https://www.openstreetmap.org");
    },
  );
});

describe("service manifest", () => {
  const manifest = JSON.parse(read("services/app-api/service.json")) as {
    container: { environment: Record<string, string> };
  };
  const environment = manifest.container.environment;

  it("passes both flags explicitly with a false fallback", () => {
    for (const flag of FLAGS) {
      expect(environment[flag]).toBe(`\${${flag}:-false}`);
    }
  });

  it("pins the production origins and the created_by version", () => {
    expect(environment.OSM_API_URL).toBe("${OSM_API_URL:-https://api.openstreetmap.org}");
    expect(environment.OSM_WEB_URL).toBe("${OSM_WEB_URL:-https://www.openstreetmap.org}");
    expect(environment.OSM_DISCOVERY_URL).toContain("https://www.openstreetmap.org/.well-known/");
    expect(environment.OPENMAPX_VERSION).toBe("${OPENMAPX_VERSION:-1.0}");
  });

  it("carries every documented rate limit", () => {
    for (const limiter of ["READ", "PREVIEW", "PUBLISH", "NOTE"]) {
      expect(environment[`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_MAX`]).toBeDefined();
      expect(environment[`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_WINDOW_MS`]).toBeDefined();
    }
  });
});
