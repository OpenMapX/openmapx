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
 * enters the camera allowlist: app.ts replaces this from the integration
 * registry whenever the source set changes, and until then it is empty.
 */
let cameraMediaSources: readonly CameraMediaSource[] = [];

const NO_GATED_SOURCES: ReadonlySet<string> = new Set();

/**
 * Source ids the operator's data-use policy disallows. Read on every check,
 * so a policy change takes effect with the policy's own refresh. Injected by
 * app.ts to keep this module free of the policy service and its database.
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

/**
 * Panoramax catalogues whose per-picture image endpoint may send the proxy on
 * to the federated instance, or that instance's storage bucket, holding the
 * file. The federation adds instances and buckets without notice, so they
 * cannot be listed here; the catalogue decides where a picture lives.
 */
const PANORAMAX_CATALOGUE_HOSTS: ReadonlySet<string> = new Set([
  "api.panoramax.xyz",
  "panoramax.openstreetmap.fr",
]);

/** `/api/pictures/<uuid>/<size>.jpg`, the endpoint every Panoramax instance serves. */
const PANORAMAX_PICTURE_PATH =
  /^\/api\/pictures\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:thumb|sd|hd)\.jpg$/i;

/** True for a request to an allowlisted Panoramax catalogue's per-picture endpoint. */
export function isPanoramaxPictureRequest(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    PANORAMAX_CATALOGUE_HOSTS.has(url.hostname) &&
    PANORAMAX_PICTURE_PATH.test(url.pathname)
  );
}

/** Redirects a picture may take to reach its file: catalogue → instance → file. */
const MAX_PANORAMAX_REDIRECTS = 2;

/**
 * The redirects a request to a catalogue's per-picture endpoint may follow to
 * hosts no allowlist names, or null for any other request.
 *
 * Panoramax sends a picture at most two redirects: the catalogue's endpoint to
 * the instance holding it (a file, or that instance's own per-picture
 * endpoint), and that endpoint to its storage bucket. The returned check is
 * stateful and must see every redirect of the request in order. It admits the
 * first only from the requested catalogue URL, the second only from a
 * per-picture endpoint, and nothing after that; each target must be HTTPS on
 * the default port. Every hop still connects only to public addresses, and the
 * response must still be a bounded image.
 */
export function panoramaxRedirectPolicy(
  request: URL,
): ((next: URL, previous: URL | undefined) => boolean) | null {
  if (!isPanoramaxPictureRequest(request)) return null;
  let redirects = 0;
  return (next, previous) => {
    redirects += 1;
    if (redirects > MAX_PANORAMAX_REDIRECTS || previous === undefined) return false;
    const fromPictureEndpoint =
      previous.protocol === "https:" && PANORAMAX_PICTURE_PATH.test(previous.pathname);
    const fromRequest = previous.href === request.href;
    if (redirects === 1 ? !fromRequest : !fromPictureEndpoint) return false;
    return next.protocol === "https:" && next.port === "";
  };
}
