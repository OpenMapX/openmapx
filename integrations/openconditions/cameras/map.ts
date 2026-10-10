import {
  type Camera,
  type CameraStatus,
  type CameraType,
  type CameraView,
  matchesMediaHost,
} from "@openmapx/integration-framework";
import {
  allowedReadings,
  CROWD_CREDIT,
  countryOf,
  credit,
  crowdReported,
  firstText,
  itemIdOf,
  keyPrefixesOf,
  type LatestReading,
  list,
  newestReading,
  pointOf,
  type Rec,
  readingFeeds,
  rec,
  sourcesOf,
  splitKey,
  str,
  upstreamCredits,
} from "../features/record.js";
import type { MediaSources } from "../sources.js";

const CAMERA_TYPES: ReadonlySet<string> = new Set<CameraType>([
  "traffic",
  "landscape",
  "city",
  "weather",
  "beach",
  "other",
]);
const CAMERA_STATUSES: ReadonlySet<string> = new Set<CameraStatus>([
  "online",
  "offline",
  "stale",
  "unknown",
]);
const REDISTRIBUTION: ReadonlySet<string> = new Set<NonNullable<CameraView["imageRedistribution"]>>(
  ["allowed", "link_only", "unknown"],
);
const STREAM_TYPES: ReadonlySet<string> = new Set<NonNullable<CameraView["streamType"]>>([
  "hls",
  "rtsp",
  "mjpeg",
  "webrtc",
  "mp4",
]);

/**
 * What the mapper asks of the live sources: each source's credit link, the
 * licence names its credits show, and each source's declared image hosts.
 */
export type CameraSources = Pick<MediaSources, "link" | "licenseName" | "mediaHosts">;

const NO_SOURCES: CameraSources = {
  link: () => undefined,
  licenseName: () => undefined,
  mediaHosts: () => [],
};

function oneOf<T extends string>(set: ReadonlySet<string>, value: unknown): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A link the browser may open: http(s) only. */
function webUrl(value: unknown): string | undefined {
  const url = str(value);
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : undefined;
}

/** A free-text direction from a `DirectionRef`: its text, else its compass point. */
function directionOf(value: unknown): string | undefined {
  const direction = rec(value);
  return str(direction["text"]) ?? str(direction["compass"]);
}

/** A road from a `RoadRef`: its number, else its name. */
function roadOf(value: unknown): string | undefined {
  const road = rec(value);
  return str(road["ref"]) ?? firstText(road["name"]);
}

/**
 * An OpenConditions `camera` record with its readings in effect as a camera.
 * Each `camera_view` component is a view, with the `camera.image` reading
 * about it; a view without a reading reads `unknown` and stale, and one whose
 * reading is past its `validUntil` at `now` is stale. The camera's refresh
 * interval is copied onto every view.
 *
 * Each view carries its own publisher's page and image terms, from its
 * component's details: a canonical camera lists every member's views, and a
 * member's still must link its own publisher (Windy's terms ask that every
 * image link to Windy), not the survivor. A view of the survivor without
 * them takes the camera's, which are the survivor's.
 *
 * A still is kept only when a source behind its reading declares the still's
 * host among its media hosts: the image proxy fetches no other. An
 * undeclared still is no image; it becomes its view's link when the view has
 * none, so the user can still see it at its publisher, and the camera's link
 * when it is the survivor's and the camera has none. A thumbnail on an
 * undeclared host, or of an undeclared still, is dropped. Links the browser
 * opens (page, player, stream, operator website) are kept only when http(s).
 *
 * Every source `excluded` holds is taken out: its credit, its readings (a
 * fused reading with an excluded contributor too) and the views it
 * published. Null when the record is not a placeable camera, when no view is
 * left, or when its survivor is excluded: the name, type and operator are
 * the survivor's.
 */
export function recordToCamera(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CameraSources = NO_SOURCES,
  now: Date = new Date(),
): Camera | null {
  const id = itemIdOf(record);
  const location = rec(record["location"]);
  const coordinates = pointOf(location);
  if (!id || record["kind"] !== "camera" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const prefixes = keyPrefixesOf(
    record,
    all.map((s) => s.id),
  );
  const readings = allowedReadings(latest, excluded);
  const details = rec(record["details"]);
  const refreshSec = positive(details["refreshSec"]);
  const cameraPage = webUrl(details["detailUrl"]);
  const cameraTerms = oneOf<NonNullable<CameraView["imageRedistribution"]>>(
    REDISTRIBUTION,
    details["imageRedistribution"],
  );
  let detailUrl = cameraPage;
  let crowd = false;

  const views: CameraView[] = [];
  for (const component of list(record["components"])) {
    const key = str(component["key"]);
    if (component["kind"] !== "camera_view" || !key) continue;
    const owner = splitKey(key, prefixes).source ?? survivor.id;
    if (excluded(owner)) continue;
    const viewDetails = rec(component["details"]);
    const ownView = owner === survivor.id;
    let viewPage = webUrl(viewDetails["detailUrl"]) ?? (ownView ? cameraPage : undefined);
    const imageRedistribution =
      oneOf<NonNullable<CameraView["imageRedistribution"]>>(
        REDISTRIBUTION,
        viewDetails["imageRedistribution"],
      ) ?? (ownView ? cameraTerms : undefined);

    const reading = newestReading(readings, "camera.image", key);
    if (crowdReported(reading)) crowd = true;
    const value = rec(rec(reading?.result)["value"]);
    // A fused reading names its contributors; any of them declaring the host admits the still.
    const contributors = reading ? readingFeeds(reading) : [];
    const declared = (url: string) =>
      contributors.some((sourceId) => matchesMediaHost(url, sources.mediaHosts(sourceId)));

    let imageUrl = str(value["imageUrl"]);
    let still = true;
    if (imageUrl !== undefined && !declared(imageUrl)) {
      viewPage ??= webUrl(imageUrl);
      // Only the survivor's still may stand for the camera's page.
      if (ownView) detailUrl ??= webUrl(imageUrl);
      imageUrl = undefined;
      still = false;
    }
    // A thumbnail goes with an undeclared still: it stands for the same image.
    const thumbnail = str(value["thumbnailUrl"]);
    const thumbnailUrl =
      still && thumbnail !== undefined && declared(thumbnail) ? thumbnail : undefined;
    // The browser opens the stream itself, so only a web link is passed on.
    const streamUrl = webUrl(value["streamUrl"]);
    const streamType = oneOf<NonNullable<CameraView["streamType"]>>(
      STREAM_TYPES,
      value["streamType"],
    );
    const imageAt = str(value["imageAt"]);
    const until = reading?.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);

    const name = firstText(component["name"]) ?? firstText(viewDetails["name"]);
    const bearingDeg = viewDetails["bearingDeg"];
    const bearing =
      typeof bearingDeg === "number" && bearingDeg >= 0 && bearingDeg < 360
        ? bearingDeg
        : undefined;
    const direction = directionOf(viewDetails["direction"]);
    const road = roadOf(viewDetails["road"]);
    views.push({
      key,
      ...(name ? { name } : {}),
      ...(bearing !== undefined ? { bearing } : {}),
      ...(direction ? { direction } : {}),
      ...(road ? { road } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(streamUrl ? { streamUrl } : {}),
      ...(streamUrl && streamType ? { streamType } : {}),
      status: (reading && oneOf<CameraStatus>(CAMERA_STATUSES, value["status"])) || "unknown",
      ...(refreshSec !== undefined ? { refreshSec } : {}),
      ...(imageAt ? { imageAt } : {}),
      stale: reading === undefined || (Number.isFinite(until) && until < now.getTime()),
      ...(viewPage ? { detailUrl: viewPage } : {}),
      ...(imageRedistribution ? { imageRedistribution } : {}),
    });
  }
  // A camera is its views: with none left there is nothing to show.
  if (views.length === 0) return null;

  const name = firstText(record["name"]);
  const country = countryOf(location);
  const operator = rec(record["operator"]);
  const operatorName = firstText(operator["name"]);
  const operatorSite = webUrl(operator["website"]);
  const playerEmbedUrl = webUrl(details["playerEmbedUrl"]);
  return {
    id,
    name: name ?? "",
    type: oneOf<CameraType>(CAMERA_TYPES, record["type"]) ?? "other",
    ...(country ? { country } : {}),
    coordinates,
    ...(operatorName
      ? { operator: { name: operatorName, ...(operatorSite ? { website: operatorSite } : {}) } }
      : {}),
    ...(detailUrl ? { detailUrl } : {}),
    ...(playerEmbedUrl ? { playerEmbedUrl } : {}),
    views,
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...(crowd ? [CROWD_CREDIT] : []),
    ],
  };
}
