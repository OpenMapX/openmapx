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

export function readMobileConfig(env: MobileEnv): Readonly<MobileBuildConfig> {
  const release = env.OPENMAPX_MOBILE_RELEASE === "1";
  const web = exactOrigin(env.OPENMAPX_MOBILE_WEB_ORIGIN ?? "https://openmapx.com", release);
  const api = exactOrigin(env.OPENMAPX_MOBILE_API_ORIGIN ?? web.origin, release);

  const baseId = env.OPENMAPX_MOBILE_APP_ID ?? "org.openmapx.app";
  const baseScheme = env.OPENMAPX_MOBILE_SCHEME ?? "openmapx";
  if (!APP_ID_PATTERN.test(baseId)) throw new Error(`invalid app id: ${JSON.stringify(baseId)}`);
  if (!URL_SCHEME_PATTERN.test(baseScheme)) {
    throw new Error(`invalid URL scheme: ${JSON.stringify(baseScheme)}`);
  }

  const appleTeamId = env.OPENMAPX_APPLE_TEAM_ID;
  if (release && (!appleTeamId || !APPLE_TEAM_ID_PATTERN.test(appleTeamId))) {
    throw new Error("release builds require OPENMAPX_APPLE_TEAM_ID as ten uppercase alphanumerics");
  }

  return Object.freeze({
    release,
    feasibilityMode: env.OPENMAPX_MOBILE_FEASIBILITY_MODE === "1",
    webOrigin: web.origin,
    apiOrigin: api.origin,
    webHost: web.hostname,
    appId: release ? baseId : `${baseId}.dev`,
    scheme: release ? baseScheme : `${baseScheme}-dev`,
    appName: env.OPENMAPX_MOBILE_APP_NAME ?? (release ? "OpenMapX" : "OpenMapX Dev"),
    ...(appleTeamId && { appleTeamId }),
  });
}
