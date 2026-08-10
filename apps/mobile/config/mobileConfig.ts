/**
 * The mobile app's only source of build-time configuration.
 *
 * Every value is read once, validated, and frozen so a signed binary can never
 * be repointed at another server. There is deliberately no runtime override, no
 * settings screen, and no deep-link parameter that reaches this module.
 */

export interface MobileBuildConfig {
  release: boolean;
  feasibilityMode: boolean;
  webOrigin: string;
  apiOrigin: string;
  webHost: string;
  appId: string;
  scheme: string;
  appName: string;
  appleTeamId?: string;
}

export type MobileEnv = Record<string, string | undefined>;

const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/i;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * Parses an origin and rejects anything that carries authority beyond scheme,
 * host and port. A path, query, fragment or userinfo component would let a
 * misconfigured build smuggle a redirect target into the WebView's allowlist.
 */
function exactOrigin(value: string, release: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid mobile origin: ${JSON.stringify(value)}`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("mobile origins must contain only scheme, host, and optional port");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("unsupported origin scheme");
  if (release && url.protocol !== "https:") throw new Error("release origins require HTTPS");
  return url;
}

/** The official store identity, and the only origins it may ever be built against. */
export const OFFICIAL_APP_ID = "org.openmapx.app";
export const OFFICIAL_ORIGIN = "https://openmapx.com";

/**
 * Hosts that cannot be reached from a user's phone on the open internet.
 *
 * A release build pointed at one of these would install and then silently fail
 * for everyone except the machine that built it.
 */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

export function readMobileConfig(env: MobileEnv): Readonly<MobileBuildConfig> {
  const release = env.OPENMAPX_MOBILE_RELEASE === "1";
  const web = exactOrigin(env.OPENMAPX_MOBILE_WEB_ORIGIN ?? OFFICIAL_ORIGIN, release);
  const api = exactOrigin(env.OPENMAPX_MOBILE_API_ORIGIN ?? web.origin, release);

  const baseId = env.OPENMAPX_MOBILE_APP_ID ?? OFFICIAL_APP_ID;
  const baseScheme = env.OPENMAPX_MOBILE_SCHEME ?? "openmapx";
  if (!APP_ID_PATTERN.test(baseId)) throw new Error(`invalid app id: ${JSON.stringify(baseId)}`);
  if (!URL_SCHEME_PATTERN.test(baseScheme)) {
    throw new Error(`invalid URL scheme: ${JSON.stringify(baseScheme)}`);
  }

  const appleTeamId = env.OPENMAPX_APPLE_TEAM_ID;
  if (release && (!appleTeamId || !APPLE_TEAM_ID_PATTERN.test(appleTeamId))) {
    throw new Error("release builds require OPENMAPX_APPLE_TEAM_ID as ten uppercase alphanumerics");
  }

  const feasibilityMode = env.OPENMAPX_MOBILE_FEASIBILITY_MODE === "1";

  if (release) {
    // The developer probe collects precise background location and shows raw
    // counters. It has no place in anything a user installs.
    if (feasibilityMode) {
      throw new Error("feasibility mode cannot be enabled in a release build");
    }
    if (baseId.endsWith(".dev")) {
      throw new Error("a release build must not use a .dev application identifier");
    }
    for (const url of [web, api]) {
      if (isNonPublicHost(url.hostname)) {
        throw new Error("release origins must be publicly reachable hosts");
      }
    }
    // The official identity is bound to the official origins. A self-hoster
    // changes the application id, scheme, associations and signing — they do not
    // repoint the signed OpenMapX app.
    if (
      baseId === OFFICIAL_APP_ID &&
      (web.origin !== OFFICIAL_ORIGIN || api.origin !== OFFICIAL_ORIGIN)
    ) {
      throw new Error(
        `the official identity ${OFFICIAL_APP_ID} may only be built against ${OFFICIAL_ORIGIN}`,
      );
    }
  }

  return Object.freeze({
    release,
    feasibilityMode,
    webOrigin: web.origin,
    apiOrigin: api.origin,
    webHost: web.hostname,
    appId: release ? baseId : `${baseId}.dev`,
    scheme: release ? baseScheme : `${baseScheme}-dev`,
    appName: env.OPENMAPX_MOBILE_APP_NAME ?? (release ? "OpenMapX" : "OpenMapX Dev"),
    ...(appleTeamId && { appleTeamId }),
  });
}
