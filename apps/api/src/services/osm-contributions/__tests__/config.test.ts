import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadOsmConfig } from "../../../utils/osm-config.js";

const DEV = {
  OSM_API_URL: "https://master.apis.dev.openstreetmap.org",
  OSM_WEB_URL: "https://master.apis.dev.openstreetmap.org",
  OSM_DISCOVERY_URL: "https://master.apis.dev.openstreetmap.org/.well-known/openid-configuration",
};

describe("loadOsmConfig defaults", () => {
  it("uses the public production origins and both flags off", () => {
    const config = loadOsmConfig({});
    expect(config.apiBase).toBe("https://api.openstreetmap.org/");
    expect(config.webBase).toBe("https://www.openstreetmap.org/");
    expect(config.discoveryUrl).toBe(
      "https://www.openstreetmap.org/.well-known/openid-configuration",
    );
    expect(config.contributionsEnabled).toBe(false);
    expect(config.directEditingEnabled).toBe(false);
    expect(config.appVersion).toBe("1.0");
    expect(config.oauthConfigured).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(loadOsmConfig({}))).toBe(true);
  });
});

describe("development overrides", () => {
  it("accepts a complete development triplet", () => {
    const config = loadOsmConfig(DEV);
    expect(config.apiBase).toBe("https://master.apis.dev.openstreetmap.org/");
    expect(config.webBase).toBe("https://master.apis.dev.openstreetmap.org/");
    expect(config.isProductionOsm).toBe(false);
  });

  it("normalizes a trailing slash exactly once", () => {
    expect(loadOsmConfig({ ...DEV, OSM_API_URL: `${DEV.OSM_API_URL}/` }).apiBase).toBe(
      "https://master.apis.dev.openstreetmap.org/",
    );
  });

  it("rejects overriding only one origin of the triplet", () => {
    expect(() => loadOsmConfig({ OSM_API_URL: DEV.OSM_API_URL })).toThrow(
      /OSM_API_URL, OSM_WEB_URL and OSM_DISCOVERY_URL/,
    );
    expect(() =>
      loadOsmConfig({ OSM_API_URL: DEV.OSM_API_URL, OSM_WEB_URL: DEV.OSM_WEB_URL }),
    ).toThrow(/OSM_API_URL, OSM_WEB_URL and OSM_DISCOVERY_URL/);
  });

  it("requires the discovery URL to share the configured website origin", () => {
    expect(() =>
      loadOsmConfig({
        ...DEV,
        OSM_DISCOVERY_URL: "https://www.openstreetmap.org/.well-known/openid-configuration",
      }),
    ).toThrow(/same origin/);
  });
});

describe("URL validation", () => {
  it("rejects credentials, query strings and fragments", () => {
    for (const value of [
      "https://user:pass@api.openstreetmap.org",
      "https://api.openstreetmap.org?x=1",
      "https://api.openstreetmap.org#frag",
    ]) {
      expect(() => loadOsmConfig({ ...DEV, OSM_API_URL: value })).toThrow(/OSM_API_URL/);
    }
  });

  it("rejects non-HTTP(S) schemes and unparsable values", () => {
    for (const value of ["ftp://api.openstreetmap.org", "file:///etc/passwd", "not a url", ""]) {
      expect(() => loadOsmConfig({ ...DEV, OSM_WEB_URL: value })).toThrow();
    }
  });
});

describe("flags and version", () => {
  it("parses documented boolean spellings", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(loadOsmConfig({ OSM_CONTRIBUTIONS_ENABLED: value }).contributionsEnabled).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", ""]) {
      expect(loadOsmConfig({ OSM_CONTRIBUTIONS_ENABLED: value }).contributionsEnabled).toBe(false);
    }
  });

  it("rejects an unrecognized boolean rather than guessing", () => {
    expect(() => loadOsmConfig({ OSM_DIRECT_EDITING_ENABLED: "ture" })).toThrow(
      /OSM_DIRECT_EDITING_ENABLED/,
    );
  });

  it("validates the version used only in created_by", () => {
    expect(loadOsmConfig({ OPENMAPX_VERSION: "2.1.0-beta+7" }).appVersion).toBe("2.1.0-beta+7");
    for (const value of ["with space", "a".repeat(65), "semi;colon", "<script>"]) {
      expect(() => loadOsmConfig({ OPENMAPX_VERSION: value })).toThrow(/OPENMAPX_VERSION/);
    }
  });

  it("derives oauthConfigured from both credentials being present", () => {
    expect(loadOsmConfig({ OSM_CLIENT_ID: "id" }).oauthConfigured).toBe(false);
    expect(loadOsmConfig({ OSM_CLIENT_SECRET: "secret" }).oauthConfigured).toBe(false);
    expect(loadOsmConfig({ OSM_CLIENT_ID: "  ", OSM_CLIENT_SECRET: "s" }).oauthConfigured).toBe(
      false,
    );
    expect(loadOsmConfig({ OSM_CLIENT_ID: "id", OSM_CLIENT_SECRET: "s" }).oauthConfigured).toBe(
      true,
    );
  });

  it("never exposes the client secret on the config object", () => {
    const config = loadOsmConfig({ OSM_CLIENT_ID: "id", OSM_CLIENT_SECRET: "top-secret" });
    expect(JSON.stringify(config)).not.toContain("top-secret");
  });
});

describe("URL builders", () => {
  const config = loadOsmConfig(DEV);

  it("appends only known relative API paths", () => {
    expect(config.apiUrl("api/0.6/node/1.json")).toBe(
      "https://master.apis.dev.openstreetmap.org/api/0.6/node/1.json",
    );
    expect(config.apiUrl("api/0.6/changeset/create")).toBe(
      "https://master.apis.dev.openstreetmap.org/api/0.6/changeset/create",
    );
  });

  it("refuses an absolute or traversing path", () => {
    for (const path of [
      "https://evil.example/api",
      "//evil.example/api",
      "api/0.6/../../admin",
      "/api/0.6/node/1.json",
    ]) {
      expect(() => config.apiUrl(path)).toThrow();
    }
  });

  it("builds public element, changeset and note URLs", () => {
    expect(config.elementUrl({ type: "node", id: 12 })).toBe(
      "https://master.apis.dev.openstreetmap.org/node/12",
    );
    expect(config.elementUrl({ type: "relation", id: 7 })).toBe(
      "https://master.apis.dev.openstreetmap.org/relation/7",
    );
    expect(config.changesetUrl(99)).toBe("https://master.apis.dev.openstreetmap.org/changeset/99");
    expect(config.noteUrl(5)).toBe("https://master.apis.dev.openstreetmap.org/note/5");
    expect(config.userProfileUrl("mapper one")).toBe(
      "https://master.apis.dev.openstreetmap.org/user/mapper%20one",
    );
  });

  it("builds an advanced-editor URL with the official element query only", () => {
    expect(config.advancedEditorUrl({ type: "way", id: 42 })).toBe(
      "https://master.apis.dev.openstreetmap.org/edit?editor=id&way=42",
    );
    const withHint = config.advancedEditorUrl({ type: "node", id: 3 }, { lat: 52.5, lon: 13.4 });
    expect(withHint).toContain("editor=id&node=3");
    expect(withHint).toContain("#map=");
    // No draft, evidence, comment or token may ever appear in a handoff URL.
    expect(withHint).not.toMatch(/comment|source|token|tag/i);
  });

  it("is the only place that names a production OSM origin", () => {
    // A deployment that points the discovery URL at the development instance
    // must also reach that instance for user details and elements; a leftover
    // hardcoded production URL would silently mix the two.
    const authSource = readFileSync(
      fileURLToPath(new URL("../../../auth.ts", import.meta.url)),
      "utf8",
    );
    expect(authSource).not.toMatch(/https:\/\/(api|www)\.openstreetmap\.org/);
    expect(authSource).toContain("getOsmConfig()");
  });

  it("builds trusted account action URLs", () => {
    expect(config.contributorTermsUrl()).toBe(
      "https://master.apis.dev.openstreetmap.org/user/terms",
    );
    expect(config.accountMessagesUrl()).toBe(
      "https://master.apis.dev.openstreetmap.org/messages/inbox",
    );
  });
});
