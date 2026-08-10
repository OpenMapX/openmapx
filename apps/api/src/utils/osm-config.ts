/**
 * The single trusted source of OpenStreetMap origins and contribution flags.
 *
 * Every upstream OSM URL in the API is built from here. Nothing is ever
 * derived from request input, so no header or body can turn the contribution
 * client into a general-purpose proxy. Production defaults to the public OSM
 * instance; a deployment may point all three origins at the OSM development
 * instance for smoke testing.
 */
import type { OsmElementRef } from "@openmapx/core";

const DEFAULT_API_URL = "https://api.openstreetmap.org";
const DEFAULT_WEB_URL = "https://www.openstreetmap.org";
const DEFAULT_DISCOVERY_URL = "https://www.openstreetmap.org/.well-known/openid-configuration";
const DEFAULT_APP_VERSION = "1.0";

const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", ""]);

export type OsmEnv = Readonly<Record<string, string | undefined>>;

export interface OsmConfig {
  /** Always ends with `/` so relative paths resolve under any base path. */
  readonly apiBase: string;
  readonly webBase: string;
  readonly discoveryUrl: string;
  /** Master UI/API feature flag. */
  readonly contributionsEnabled: boolean;
  /** Independent kill switch for direct element writes. */
  readonly directEditingEnabled: boolean;
  /** Used only in the changeset `created_by` tag. */
  readonly appVersion: string;
  /** Both OAuth credentials are present and non-blank. */
  readonly oauthConfigured: boolean;
  /** False when the deployment points at a non-production OSM instance. */
  readonly isProductionOsm: boolean;
  apiUrl(relativePath: string): string;
  webUrl(relativePath: string): string;
  elementUrl(ref: OsmElementRef): string;
  changesetUrl(changesetId: number): string;
  noteUrl(noteId: number): string;
  userProfileUrl(displayName: string): string;
  advancedEditorUrl(ref: OsmElementRef, center?: { lat: number; lon: number }): string;
  contributorTermsUrl(): string;
  accountMessagesUrl(): string;
}

function readRaw(env: OsmEnv, name: string): string | undefined {
  const value = env[name];
  return value != null && value.trim() !== "" ? value.trim() : undefined;
}

function parseBaseUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.search) throw new Error(`${name} must not contain a query string`);
  if (url.hash) throw new Error(`${name} must not contain a fragment`);
  // A trailing slash makes every later `new URL(relative, base)` keep the
  // configured base path instead of silently discarding it.
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`${name} must be one of true/false/1/0/yes/no/on/off`);
}

/** Reject absolute, protocol-relative or traversing paths before joining. */
function assertRelativePath(relativePath: string): void {
  if (relativePath.startsWith("/") || relativePath.includes("//")) {
    throw new Error("OSM path must be relative to the configured base");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relativePath)) {
    throw new Error("OSM path must not be absolute");
  }
  if (relativePath.split("/").includes("..")) {
    throw new Error("OSM path must not traverse");
  }
}

export function loadOsmConfig(env: OsmEnv = process.env): OsmConfig {
  const rawApi = readRaw(env, "OSM_API_URL");
  const rawWeb = readRaw(env, "OSM_WEB_URL");
  const rawDiscovery = readRaw(env, "OSM_DISCOVERY_URL");

  const configuredCount = [rawApi, rawWeb, rawDiscovery].filter(Boolean).length;
  if (configuredCount > 0 && configuredCount < 3) {
    throw new Error(
      "OSM_API_URL, OSM_WEB_URL and OSM_DISCOVERY_URL must be configured together; " +
        "pointing only one at another OSM instance mixes production and development data",
    );
  }

  const api = parseBaseUrl("OSM_API_URL", rawApi ?? DEFAULT_API_URL);
  const web = parseBaseUrl("OSM_WEB_URL", rawWeb ?? DEFAULT_WEB_URL);

  const discoveryRaw = rawDiscovery ?? DEFAULT_DISCOVERY_URL;
  let discovery: URL;
  try {
    discovery = new URL(discoveryRaw);
  } catch {
    throw new Error("OSM_DISCOVERY_URL must be an absolute http(s) URL");
  }
  if (discovery.protocol !== "https:" && discovery.protocol !== "http:") {
    throw new Error("OSM_DISCOVERY_URL must use http or https");
  }
  if (discovery.username || discovery.password) {
    throw new Error("OSM_DISCOVERY_URL must not contain credentials");
  }
  // The discovery document decides which instance issues tokens, so it must
  // belong to the same website the deployment already trusts.
  if (discovery.origin !== web.origin) {
    throw new Error("OSM_DISCOVERY_URL must share the same origin as OSM_WEB_URL");
  }

  const appVersion = readRaw(env, "OPENMAPX_VERSION") ?? DEFAULT_APP_VERSION;
  if (!VERSION_PATTERN.test(appVersion)) {
    throw new Error("OPENMAPX_VERSION must be 1-64 characters from [A-Za-z0-9._+-]");
  }

  const apiBase = api.toString();
  const webBase = web.toString();

  const config: OsmConfig = {
    apiBase,
    webBase,
    discoveryUrl: discovery.toString(),
    contributionsEnabled: parseBoolean("OSM_CONTRIBUTIONS_ENABLED", env.OSM_CONTRIBUTIONS_ENABLED),
    directEditingEnabled: parseBoolean(
      "OSM_DIRECT_EDITING_ENABLED",
      env.OSM_DIRECT_EDITING_ENABLED,
    ),
    appVersion,
    oauthConfigured:
      readRaw(env, "OSM_CLIENT_ID") !== undefined &&
      readRaw(env, "OSM_CLIENT_SECRET") !== undefined,
    isProductionOsm: api.origin === new URL(DEFAULT_API_URL).origin,
    apiUrl(relativePath: string): string {
      assertRelativePath(relativePath);
      return new URL(relativePath, apiBase).toString();
    },
    webUrl(relativePath: string): string {
      assertRelativePath(relativePath);
      return new URL(relativePath, webBase).toString();
    },
    elementUrl(ref: OsmElementRef): string {
      return new URL(`${ref.type}/${ref.id}`, webBase).toString();
    },
    changesetUrl(changesetId: number): string {
      return new URL(`changeset/${changesetId}`, webBase).toString();
    },
    noteUrl(noteId: number): string {
      return new URL(`note/${noteId}`, webBase).toString();
    },
    userProfileUrl(displayName: string): string {
      return new URL(`user/${encodeURIComponent(displayName)}`, webBase).toString();
    },
    advancedEditorUrl(ref: OsmElementRef, center?: { lat: number; lon: number }): string {
      // iD's documented element query: `editor=id` plus exactly one of
      // node/way/relation. Coordinates are only an orientation hint.
      const url = new URL("edit", webBase);
      url.searchParams.set("editor", "id");
      url.searchParams.set(ref.type, String(ref.id));
      let result = url.toString();
      if (center) {
        result += `#map=18/${center.lat.toFixed(5)}/${center.lon.toFixed(5)}`;
      }
      return result;
    },
    contributorTermsUrl(): string {
      return new URL("user/terms", webBase).toString();
    },
    accountMessagesUrl(): string {
      return new URL("messages/inbox", webBase).toString();
    },
  };

  return Object.freeze(config);
}

let cached: OsmConfig | undefined;

/** Process-wide validated configuration, built once at first use. */
export function getOsmConfig(): OsmConfig {
  if (!cached) cached = loadOsmConfig();
  return cached;
}

/** Test-only reset so a case can vary the environment. */
export function resetOsmConfigForTests(): void {
  cached = undefined;
}
