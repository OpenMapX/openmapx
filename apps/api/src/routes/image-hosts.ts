/**
 * Allowed upstream hostname patterns for the image proxy.
 * Prevents abuse by only allowing known photo-source domains.
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
  // Windy webcams — `images-webcams.windy.com` etc. serve still-image
  // previews for the Windy webcam integration.
  "windy.com",
  // Webcam-integration provider stills (`integrations/webcam/providers/*`).
  // Each entry covers the operator domain + any subdomains via the existing
  // endsWith('.<host>') match. AWS S3 buckets (e.g. TfL JamCam) are
  // intentionally excluded — opening *.amazonaws.com is too permissive.
  "nps.gov", // NPS — `www.nps.gov/...`
  "dot.ca.gov", // Caltrans — `cwwp2.dot.ca.gov`
  "tripcheck.com", // Oregon DOT — `tripcheck.com/RoadCams/...`
  "511ny.org", // New York 511
  "511ga.org", // Georgia 511
  "fl511.com", // Florida 511
  "az511.com", // Arizona 511
  "511.idaho.gov", // Idaho 511 (exact host)
  "ibi511.com", // shared ibi511 host (Utah uses prod-ut.ibi511.com)
  "511la.org", // Louisiana 511
  "511pa.com", // Pennsylvania 511 (covers www.511pa.com)
  "weathercam.digitraffic.fi", // Finland Digitraffic weather cameras
  "api.trafikinfo.trafikverket.se", // Sweden Trafikverket camera stills
  "kamera.atlas.vegvesen.no", // Norway NPRA camera stills
  "vegagerdin.is", // Iceland Road Administration camera stills
  "etraffic.dgt.es", // Spain DGT camera stills
  "511on.ca", // Ontario 511 camera stills
  "tdcctv.data.one.gov.hk", // Hong Kong Transport Department camera stills
  "webcams.transport.nsw.gov.au", // Live Traffic NSW camera stills
  "freeway.gov.tw", // Taiwan freeway camera stills
];

/**
 * True only when `hostname` exactly matches an allowlisted host or is a
 * subdomain of one (the leading `.` in `endsWith` enforces the label boundary,
 * so `upload.wikimedia.org.attacker.com` and `xupload.wikimedia.org` are
 * rejected). Exported for direct SSRF-allowlist testing.
 */
export function isAllowedHost(hostname: string): boolean {
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
