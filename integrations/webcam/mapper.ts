import {
  type DataSourceAttribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  isSafeHttpUrl,
  validObservedAt,
} from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type { Camera, CameraView } from "@openmapx/mobility-core/camera";

type Row = [I18nToken, Translatable];

/** Streams the browser plays in a video element; any other stream opens in a frame. */
const VIDEO_STREAMS: ReadonlySet<NonNullable<CameraView["streamType"]>> = new Set(["hls", "mp4"]);

/** Whether a view shows nothing current: offline, or a still that is no longer fresh. */
function down(view: CameraView): boolean {
  return view.status === "offline" || view.status === "stale" || view.stale;
}

/**
 * The camera's state as the map shows it: every view down dims the marker,
 * one fresh online view makes it operational, anything else is unknown.
 */
function statusOf(camera: Camera): string {
  if (camera.views.every(down)) return "non-operational";
  return camera.views.some((v) => v.status === "online" && !v.stale) ? "operational" : "unknown";
}

/** The newest time a still of the camera was taken. */
function newestImageAt(camera: Camera): string | undefined {
  let newest: string | undefined;
  for (const view of camera.views) {
    const at = validObservedAt(view.imageAt);
    if (at && (newest === undefined || Date.parse(at) > Date.parse(newest))) newest = at;
  }
  return newest;
}

/** Which way a view looks: its stated direction, else its bearing. */
function directionOf(view: CameraView): Translatable | undefined {
  if (view.direction) return view.direction;
  return view.bearing === undefined ? undefined : token("bearing", { bearing: view.bearing });
}

function summaryOf(camera: Camera): I18nToken | undefined {
  if (camera.views.length > 1) return token("summary.views", { count: camera.views.length });
  const [only] = camera.views;
  const direction = only && directionOf(only);
  return direction === undefined ? undefined : token("summary.direction", { direction });
}

/** A camera's title when its sources name it nothing. */
function fallbackNameOf(camera: Camera): { fallbackName?: I18nToken } {
  return camera.name ? {} : { fallbackName: token("fallbackName") };
}

/**
 * The camera's credits as per-record attributions: the `webcam` manifest
 * declares no sources of its own, so every credit comes from the providers.
 * Their links come from upstream data, so only http(s) ones are kept.
 */
function cameraCredits(camera: Camera): DataSourceAttribution[] | undefined {
  if (camera.attributions.length === 0) return undefined;
  return camera.attributions.map((a) => ({
    text: a.name,
    url: isSafeHttpUrl(a.url) ? a.url : "",
    ...(a.spdxLicense ? { license: a.spdxLicense } : {}),
    ...(isSafeHttpUrl(a.licenseUrl) ? { licenseUrl: a.licenseUrl } : {}),
  }));
}

/**
 * Each view's title: its name, else its direction, else its bearing, else
 * its number. A title two views share gets the later view's number, since
 * the place panel tells sections apart by their titles.
 */
function viewTitles(camera: Camera): I18nToken[] {
  const seen = new Set<string>();
  return camera.views.map((view, index) => {
    const n = index + 1;
    const own = view.name ?? view.direction;
    const title = own
      ? token("literal", { value: own })
      : view.bearing !== undefined
        ? token("view.facing", { bearing: view.bearing })
        : token("view.numbered", { n });
    const key = JSON.stringify(title);
    if (!seen.has(key)) {
      seen.add(key);
      return title;
    }
    return token("view.repeated", { view: title, n });
  });
}

function captionOf(view: CameraView): I18nToken {
  if (view.status === "offline") return token("caption.offline");
  if (view.status === "stale" || view.stale) return token("caption.stale");
  return token("caption.updated");
}

/**
 * One still per view that has one, refreshed at the camera's pace and linked
 * to its view's own page, else the camera's: a camera linked across sources
 * shows each member's still, which must link that member's publisher.
 */
function imageSection(
  camera: Camera,
  view: CameraView,
  title: I18nToken,
  cameraLink: string | undefined,
): DataSourceDetailSection | null {
  const imageUrl = view.imageUrl ?? view.thumbnailUrl;
  if (!imageUrl) return null;
  const link = isSafeHttpUrl(view.detailUrl) ? view.detailUrl : cameraLink;
  const imageAt = validObservedAt(view.imageAt);
  return {
    title,
    type: "image",
    sectionIcon: "videocam",
    imageUrl,
    imageAlt: token("imageAlt.webcam", { name: camera.name || title }),
    caption: captionOf(view),
    ...(imageAt ? { captionTimestamp: imageAt } : {}),
    ...(link ? { linkUrl: link } : {}),
    ...(view.refreshSec ? { refreshSec: view.refreshSec } : {}),
  };
}

/** A view's stream, behind the consent card the place panel shows for every embed. */
function streamSection(
  camera: Camera,
  view: CameraView,
  title: I18nToken,
): DataSourceDetailSection | null {
  if (!view.streamUrl || !isSafeHttpUrl(view.streamUrl)) return null;
  return {
    title:
      camera.views.length > 1
        ? token("section.viewStream", { view: title })
        : token("section.liveStream"),
    type: "embed",
    sectionIcon: "videocam",
    embedUrl: view.streamUrl,
    embedType: view.streamType && VIDEO_STREAMS.has(view.streamType) ? "video" : "iframe",
  };
}

/** Every road the views name, each once. */
function roadsOf(camera: Camera): string | undefined {
  const roads = [...new Set(camera.views.flatMap((v) => (v.road ? [v.road] : [])))];
  return roads.length > 0 ? roads.join(", ") : undefined;
}

function refreshValue(seconds: number): I18nToken {
  return seconds >= 60 && seconds % 60 === 0
    ? token("value.refreshMinutes", { minutes: seconds / 60 })
    : token("value.refreshSeconds", { seconds });
}

function infoSection(camera: Camera): DataSourceDetailSection | null {
  const rows: Row[] = [];
  const road = roadsOf(camera);
  if (road) rows.push([token("row.road"), road]);
  const provider = camera.operator?.name ?? camera.attributions[0]?.name;
  if (provider) rows.push([token("row.provider"), provider]);
  const refreshSec = camera.views.find((v) => v.refreshSec)?.refreshSec;
  if (refreshSec) rows.push([token("row.refresh"), refreshValue(refreshSec)]);
  if (rows.length === 0) return null;
  return { title: sharedT.section.info, type: "table", rows, sectionIcon: "info" };
}

export function mapCameraToResult(camera: Camera): DataSourceResult {
  const observedAt = newestImageAt(camera);
  const result: DataSourceResult = {
    id: camera.id,
    name: camera.name,
    ...fallbackNameOf(camera),
    coordinates: camera.coordinates,
    source: camera.sources[0] ?? "unknown",
    sources: camera.sources,
    variant: camera.type,
    status: statusOf(camera),
    summary: summaryOf(camera),
    operator: camera.operator?.name,
    ...(observedAt ? { observedAt } : {}),
  };
  const attributions = cameraCredits(camera);
  if (attributions) result.attributions = attributions;
  return result;
}

/**
 * The camera's detail: a refreshing still per view, then each stream and
 * the third-party player (both load only after the reader's consent), then
 * the road, the provider and the refresh interval. Every still links to its
 * view's page, else the camera's, which some publishers' terms require of a
 * shown image.
 */
export function mapCameraToDetail(camera: Camera): DataSourceDetail {
  const link = isSafeHttpUrl(camera.detailUrl) ? camera.detailUrl : undefined;
  const titles = viewTitles(camera);
  const sections: DataSourceDetailSection[] = [];
  camera.views.forEach((view, i) => {
    const image = imageSection(camera, view, titles[i], link);
    if (image) sections.push(image);
  });
  camera.views.forEach((view, i) => {
    const stream = streamSection(camera, view, titles[i]);
    if (stream) sections.push(stream);
  });
  if (camera.playerEmbedUrl && isSafeHttpUrl(camera.playerEmbedUrl)) {
    sections.push({
      title: token("section.liveTimelapse"),
      type: "embed",
      sectionIcon: "open_in_new",
      embedUrl: camera.playerEmbedUrl,
      embedType: "iframe",
    });
  }
  const info = infoSection(camera);
  if (info) sections.push(info);

  const operatorSite = isSafeHttpUrl(camera.operator?.website)
    ? camera.operator.website
    : undefined;
  const detail: DataSourceDetail = {
    id: camera.id,
    sources: camera.sources,
    name: camera.name,
    ...fallbackNameOf(camera),
    coordinates: camera.coordinates,
    operator: camera.operator
      ? { name: camera.operator.name, ...(operatorSite ? { url: operatorSite } : {}) }
      : undefined,
    ...(link ? { website: link } : {}),
    sections,
  };
  const attributions = cameraCredits(camera);
  if (attributions) detail.attributions = attributions;
  return detail;
}
