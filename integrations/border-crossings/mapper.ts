import {
  type Attribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  validObservedAt,
} from "@openmapx/core";
import { siteAttributions } from "@openmapx/integration-framework";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type {
  BorderCrossing,
  BorderCrossingMode,
  BorderCrossingProgram,
  BorderCrossingQueue,
} from "@openmapx/mobility-core/border-crossing";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import strings from "./strings/en.json" with { type: "json" };

type Row = [I18nToken, Translatable | Translatable[]];

/** How long the queues are, as the map colours a crossing. */
export type WaitBand = "short" | "moderate" | "long";

/** The longest wait, in minutes, that is still short, and that is still moderate. */
const SHORT_MAX = 15;
const MODERATE_MAX = 45;

const MODE_ORDER: readonly BorderCrossingMode[] = [
  "passenger",
  "commercial",
  "pedestrian",
  "bus",
  "rail",
];
const PROGRAM_ORDER: readonly BorderCrossingProgram[] = [
  "standard",
  "trusted_traveller",
  "ready_lane",
  "fast",
];
/** The modes a crossing's summary names, in order. */
const SUMMARY_MODES: readonly BorderCrossingMode[] = ["passenger", "commercial", "pedestrian"];

/** The countries the strings name a direction into; any other is named by its code. */
const NAMED_COUNTRIES = new Set(Object.keys(strings.into));

const programOf = (queue: BorderCrossingQueue): BorderCrossingProgram =>
  queue.program ?? "standard";

/** A queue whose wait is stated now. */
const waiting = (queue: BorderCrossingQueue): boolean =>
  !queue.stale && (queue.status === "no_delay" || queue.status === "delay");

function bandOf(queue: BorderCrossingQueue): WaitBand {
  if (queue.waitMinutes === undefined) return queue.status === "no_delay" ? "short" : "moderate";
  if (queue.waitMinutes <= SHORT_MAX) return "short";
  return queue.waitMinutes <= MODERATE_MAX ? "moderate" : "long";
}

/**
 * The queues the marker and the sort speak for: the cars' standard lanes
 * when any of them states a wait, since most who cross queue there, else
 * every queue that states one.
 */
function headlineQueues(crossing: BorderCrossing): BorderCrossingQueue[] {
  const stated = crossing.queues.filter(waiting);
  const cars = stated.filter((q) => q.mode === "passenger" && programOf(q) === "standard");
  return cars.length > 0 ? cars : stated;
}

/** The longest of the queues, by band and then minutes. */
function longest(queues: readonly BorderCrossingQueue[]): BorderCrossingQueue | undefined {
  const rank = (q: BorderCrossingQueue) => ["short", "moderate", "long"].indexOf(bandOf(q));
  return queues.reduce<BorderCrossingQueue | undefined>((worst, q) => {
    if (worst === undefined) return q;
    const byBand = rank(q) - rank(worst);
    return byBand > 0 || (byBand === 0 && (q.waitMinutes ?? 0) > (worst.waitMinutes ?? 0))
      ? q
      : worst;
  }, undefined);
}

/** Whether the crossing is closed now: as a publisher states it, or every current queue closed. */
function closed(crossing: BorderCrossing): boolean {
  if (crossing.open === "closed") return true;
  const current = crossing.queues.filter((q) => !q.stale && q.status !== "unknown");
  return current.length > 0 && current.every((q) => q.status === "closed");
}

/** The marker variant: the band of the longest headline wait, closed, or unknown. */
export function variantOf(crossing: BorderCrossing): WaitBand | "closed" | "unknown" {
  if (closed(crossing)) return "closed";
  const worst = longest(headlineQueues(crossing));
  return worst ? bandOf(worst) : "unknown";
}

function statusOf(crossing: BorderCrossing): string {
  const variant = variantOf(crossing);
  if (variant === "closed") return "non-operational";
  return variant === "unknown" ? "unknown" : "operational";
}

/** A queue's wait as the reader reads it: minutes, hours and minutes, or what it is instead. */
export function waitOf(queue: BorderCrossingQueue): I18nToken {
  if (queue.stale) return token("wait.stale");
  if (queue.status === "closed") return token("wait.closed");
  if (queue.status === "unknown") return token("wait.unknown");
  const minutes = queue.waitMinutes;
  if (minutes === undefined)
    return token(queue.status === "no_delay" ? "wait.none" : "wait.delayed");
  if (minutes < 60) return token("wait.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0
    ? token("wait.wholeHours", { hours })
    : token("wait.hours", { hours, minutes: minutes % 60 });
}

function queueLabel(queue: BorderCrossingQueue): I18nToken {
  const mode = token(`mode.${queue.mode}`);
  const program = programOf(queue);
  return program === "standard"
    ? mode
    : token("queue.program", { mode, program: token(`program.${program}`) });
}

const intoKey = (country: string) => (NAMED_COUNTRIES.has(country) ? country : "other");

function joined(parts: I18nToken[]): I18nToken | undefined {
  const [first, second, third] = parts;
  if (first === undefined) return undefined;
  if (second === undefined) return first;
  if (third === undefined) return token("summary.two", { first, second });
  return token("summary.three", { first, second, third });
}

/**
 * Each direction's headline wait where the crossing's queues go both ways,
 * else the longest standard-lane wait of the cars, the trucks and the
 * pedestrians.
 */
function summaryOf(crossing: BorderCrossing): I18nToken {
  if (closed(crossing)) return token("summary.closed");
  const headline = headlineQueues(crossing);
  const directions = [...new Set(headline.flatMap((q) => (q.to ? [q.to] : [])))].sort();
  const parts =
    directions.length > 1
      ? directions.flatMap((to) => {
          const worst = longest(headline.filter((q) => q.to === to));
          return worst ? [token(`into.${intoKey(to)}`, { country: to, wait: waitOf(worst) })] : [];
        })
      : SUMMARY_MODES.flatMap((mode) => {
          const worst = longest(
            crossing.queues.filter(
              (q) => waiting(q) && q.mode === mode && programOf(q) === "standard",
            ),
          );
          return worst
            ? [token("summary.mode", { mode: token(`mode.${mode}`), wait: waitOf(worst) })]
            : [];
        });
  return joined(parts) ?? token("summary.unknown");
}

function fallbackNameOf(crossing: BorderCrossing): { fallbackName?: I18nToken } {
  return crossing.name ? {} : { fallbackName: token("fallbackName") };
}

function crossingCredits(crossing: BorderCrossing): Attribution[] | undefined {
  if (crossing.attributions.length === 0) return undefined;
  return snapshotContributors(crossing.attributions);
}

const byQueueOrder = (a: BorderCrossingQueue, b: BorderCrossingQueue) =>
  MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) ||
  PROGRAM_ORDER.indexOf(programOf(a)) - PROGRAM_ORDER.indexOf(programOf(b));

function newestOf(queues: readonly BorderCrossingQueue[]): string | undefined {
  return queues
    .flatMap((q) => (q.updatedAt ? [q.updatedAt] : []))
    .reduce<string | undefined>(
      (newest, at) => (newest === undefined || Date.parse(at) > Date.parse(newest) ? at : newest),
      undefined,
    );
}

/** One table per direction, its queues cars first, each with its wait and the lanes open. */
function directionSections(crossing: BorderCrossing): DataSourceDetailSection[] {
  const directions = [...new Set(crossing.queues.map((q) => q.to ?? ""))].sort();
  return directions.map((to) => {
    const queues = crossing.queues.filter((q) => (q.to ?? "") === to).sort(byQueueOrder);
    const rows: Row[] = queues.map((q) => {
      const wait = waitOf(q);
      return [
        queueLabel(q),
        q.lanesOpen !== undefined && waiting(q)
          ? token("wait.withLanes", { wait, lanes: q.lanesOpen })
          : wait,
      ];
    });
    const fresh = queues.filter((q) => !q.stale);
    const updatedAt = validObservedAt(newestOf(fresh.length > 0 ? fresh : queues));
    return {
      title: to ? token(`section.into.${intoKey(to)}`, { country: to }) : token("section.waits"),
      type: "table",
      rows,
      sectionIcon: "directions_car",
      ...(updatedAt ? { caption: token("caption.updated"), captionTimestamp: updatedAt } : {}),
    };
  });
}

function infoSection(crossing: BorderCrossing): DataSourceDetailSection | null {
  const rows: Row[] = [];
  if (crossing.open) {
    rows.push([
      token("row.status"),
      crossing.open === "open" ? sharedT.value.open : sharedT.value.closed,
    ]);
  }
  if (crossing.location) rows.push([token("row.location"), crossing.location]);
  const providers = [...new Set(crossing.attributions.map((a) => a.name))];
  if (providers.length === 1) rows.push([token("row.provider"), providers[0]!]);
  if (providers.length > 1) rows.push([token("row.providers"), providers]);
  if (rows.length === 0) return null;
  return { title: sharedT.section.info, type: "table", rows, sectionIcon: "info" };
}

export function mapCrossingToResult(crossing: BorderCrossing): DataSourceResult {
  const worst = closed(crossing) ? undefined : longest(headlineQueues(crossing));
  const observedAt = validObservedAt(newestOf(crossing.queues.filter((q) => !q.stale)));
  const result: DataSourceResult = {
    id: crossing.id,
    name: crossing.name,
    ...fallbackNameOf(crossing),
    coordinates: crossing.coordinates,
    source: crossing.sources[0] ?? "unknown",
    sources: [...crossing.sources],
    contributors: siteAttributions([crossing]),
    variant: variantOf(crossing),
    status: statusOf(crossing),
    summary: summaryOf(crossing),
    ...(worst ? { sortValues: { waitMinutes: worst.waitMinutes ?? 0 } } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
  const attributions = crossingCredits(crossing);
  if (attributions) result.attributions = attributions;
  return result;
}

/**
 * The crossing's detail: a table of queues for each direction across it,
 * each with its wait and the lanes open and the time it was stated, then
 * whether the crossing is open, where it is and who publishes its waits.
 * Its opening hours are the place's own.
 */
export function mapCrossingToDetail(crossing: BorderCrossing): DataSourceDetail {
  const sections: DataSourceDetailSection[] =
    crossing.queues.length > 0
      ? directionSections(crossing)
      : [
          {
            title: token("section.waits"),
            type: "text",
            content: token("text.noQueues"),
            sectionIcon: "info",
          },
        ];
  const info = infoSection(crossing);
  if (info) sections.push(info);
  const detail: DataSourceDetail = {
    id: crossing.id,
    sources: [...crossing.sources],
    contributors: siteAttributions([crossing]),
    name: crossing.name,
    ...fallbackNameOf(crossing),
    coordinates: crossing.coordinates,
    ...(crossing.openingHours ? { openingHours: crossing.openingHours } : {}),
    sections,
  };
  const attributions = crossingCredits(crossing);
  if (attributions) detail.attributions = attributions;
  return detail;
}
