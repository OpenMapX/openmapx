import { matchesMediaHost } from "@openmapx/integration-framework";

/**
 * Static upstream hostname patterns for the image proxy and place photos.
 * Prevents abuse by only allowing known photo-source domains. Camera stills
 * are admitted separately, through the hosts their live sources declare.
 */
const ALLOWED_HOSTS = [
  // Wikimedia Commons
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  // Mapillary (CDN uses regional subdomains like scontent-fra5-2.xx.fbcdn.net)
  "images.mapillary.com",
  // Mapillary's own CDN host, used as the thumbnail fallback when the API
  // doesn't return a `thumb_*_url`. Proxying it keeps the fallback server-side.
  "scontent.mapillary.com",
  // Mapillary's image CDN is served from Facebook's `xx.fbcdn.net`
  // infrastructure. We deliberately do NOT allow `fbcdn.net` wholesale —
  // that would whitelist arbitrary Facebook-hosted user content. Only
  // `xx.fbcdn.net` itself and its subdomains are matched here (in
  // practice Mapillary serves from regional subdomains like
  // `scontent-fra5-2.xx.fbcdn.net`).
  "xx.fbcdn.net",
  // Flickr
  "live.staticflickr.com",
  // Panoramax
  "api.panoramax.xyz",
  "panoramax.openstreetmap.fr",
  // Google (resolved Google Photos)
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
  // Google Photos (share links resolved on the fly)
  "photos.app.goo.gl",
  "photos.google.com",
  // OpenStreetMap / other
  "openstreetmap.org", // OAuth/profile avatars and other OSM-hosted user images
  "tile.openstreetmap.org",
  // Gravatar — OSM serves a user's avatar from Gravatar when they enable it,
  // so `user.img.href` is a `*.gravatar.com` URL (www/secure/CDN subdomains).
  "gravatar.com",
  // Entur Mobility branding/vehicle assets exposed by the server-side provider.
  "api.entur.io",
  // Mangrove review photos. Passive thumbnail loads should not expose the
  // viewer's IP address to Mangrove's file host.
  "files.mangrove.reviews",
];

/**
 * True only when `hostname` exactly matches a static allowlisted host or is a
 * subdomain of one (the leading `.` in `endsWith` enforces the label boundary,
 * so `upload.wikimedia.org.attacker.com` and `xupload.wikimedia.org` are
 * rejected). Place photos use this list alone: a camera operator's host is
 * no source of place photos.
 */
export function isStaticImageHost(hostname: string): boolean {
  // Commons image thumbnails use this one host. Do not admit its subdomains.
  if (hostname === "thumb.wikimedia.org") return true;
  // OpenStreetMap serves uploaded user avatars from a dedicated S3 bucket. The
  // Active Storage redirect URL we store (on `www.openstreetmap.org`, already
  // allowlisted) 302s to a virtual-hosted bucket URL whose region/dualstack
  // form varies (e.g. `openstreetmap-user-avatars.s3.dualstack.eu-west-1.
  // amazonaws.com`). Match that one bucket by its exact leftmost label, anchored
  // under `.amazonaws.com`, so OSM avatars load without opening the rest of
  // `*.amazonaws.com` (which the allowlist deliberately excludes).
  if (
    hostname.split(".")[0] === "openstreetmap-user-avatars" &&
    hostname.endsWith(".amazonaws.com")
  )
    return true;
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

export interface CameraMediaSource {
  sourceId: string;
  mediaHosts: readonly string[];
}

/**
 * The live data sources that declare camera image hosts. Nothing else ever
 * enters the camera allowlist: server.ts replaces this from the integration
 * registry whenever the source set changes, and until then it is empty.
 */
let cameraMediaSources: readonly CameraMediaSource[] = [];

const NO_GATED_SOURCES: ReadonlySet<string> = new Set();

/**
 * Source ids the operator's data-use policy disallows. Read on every check,
 * so a policy change takes effect with the policy's own refresh. Injected by
 * server.ts to keep this module free of the policy service and its database.
 */
let gatedSourceIds: () => ReadonlySet<string> = () => NO_GATED_SOURCES;

export function setCameraMediaSources(sources: readonly CameraMediaSource[]): void {
  cameraMediaSources = sources.map((s) => ({
    sourceId: s.sourceId,
    mediaHosts: [...s.mediaHosts],
  }));
}

export function setGatedImageSourceResolver(resolve: () => ReadonlySet<string>): void {
  gatedSourceIds = resolve;
}

interface MediaHostDeclarer {
  enabled: boolean;
  manifest: {
    dataSources?: ReadonlyArray<{ sourceId: string; mediaHosts?: readonly string[] }>;
  };
}

/** Every enabled integration's live data sources that declare media hosts. */
export function cameraMediaSourcesOf(
  integrations: Iterable<MediaHostDeclarer>,
): CameraMediaSource[] {
  const sources: CameraMediaSource[] = [];
  for (const integration of integrations) {
    if (!integration.enabled) continue;
    for (const { sourceId, mediaHosts } of integration.manifest.dataSources ?? []) {
      if (mediaHosts && mediaHosts.length > 0) sources.push({ sourceId, mediaHosts });
    }
  }
  return sources;
}

function matchesAdmittedCameraSource(url: URL): boolean {
  const gated = gatedSourceIds();
  return cameraMediaSources.some(
    (source) => !gated.has(source.sourceId) && matchesMediaHost(url, source.mediaHosts),
  );
}

/**
 * True when `url` is admitted only through a camera source's declared media
 * hosts. Such a still changes every few minutes, so it is sent uncached.
 */
export function isCameraHost(url: URL): boolean {
  return !isStaticImageHost(url.hostname) && matchesAdmittedCameraSource(url);
}

/**
 * The image proxy's allowlist: the static hosts and the hosts declared by
 * camera sources the data-use policy allows.
 */
export function isAllowedHost(url: URL): boolean {
  return isStaticImageHost(url.hostname) || matchesAdmittedCameraSource(url);
}
