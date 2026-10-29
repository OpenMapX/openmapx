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
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { ServiceVehicle } from "@openmapx/mobility-core/service-vehicle";
import strings from "./strings/en.json" with { type: "json" };

type Row = [I18nToken, Translatable | Translatable[]];

/** What a vehicle is doing, as the map colours it. */
export type VehicleWork = "plowing" | "spreading" | "other" | "unknown";

/** Every task code the strings label; any other is shown as the publisher writes it. */
const LABELLED_TASKS = new Set(Object.keys(strings.task));

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** The publisher's own code for a task it does not know. */
const UNKNOWN_TASK = "UNKNOWN";

const taskLabel = (code: string): Translatable =>
  LABELLED_TASKS.has(code) ? token(`task.${code}`) : code;

/** The tasks that say what the vehicle does; the publisher's unknown task says nothing. */
const statedTasks = (vehicle: ServiceVehicle): string[] =>
  vehicle.tasks.filter((t) => t !== UNKNOWN_TASK);

/**
 * The marker variant: ploughing when the blade is down, spreading when the
 * spreader spreads salt or sand, other work for any other task, unknown
 * when the vehicle reports none.
 */
export function variantOf(vehicle: ServiceVehicle): VehicleWork {
  if (vehicle.plowDown === true || vehicle.activity === "plowing") return "plowing";
  if (
    vehicle.spreaderOn === true ||
    vehicle.activity === "salting" ||
    vehicle.activity === "sanding"
  ) {
    return "spreading";
  }
  return statedTasks(vehicle).length > 0 ? "other" : "unknown";
}

/**
 * What the vehicle is called by the work it does, since its publisher names
 * no vehicle: a spreader by what it spreads, when it says.
 */
function nameOf(vehicle: ServiceVehicle): I18nToken {
  const work = variantOf(vehicle);
  if (work === "spreading" && (vehicle.activity === "salting" || vehicle.activity === "sanding")) {
    return token(`vehicle.${vehicle.activity}`);
  }
  return token(work === "plowing" || work === "spreading" ? `vehicle.${work}` : "vehicle.other");
}

/** The activities the strings name; an unknown one says nothing worth a row. */
const LABELLED_ACTIVITIES = new Set(Object.keys(strings.activity));

function summaryOf(vehicle: ServiceVehicle): I18nToken {
  const [first, ...rest] = statedTasks(vehicle);
  if (first === undefined) return token("summary.noTask");
  if (rest.length === 0) return token("summary.task", { task: taskLabel(first) });
  return token("summary.tasks", { task: taskLabel(first), count: rest.length });
}

function vehicleCredits(vehicle: ServiceVehicle): Attribution[] | undefined {
  if (vehicle.attributions.length === 0) return undefined;
  return snapshotContributors(vehicle.attributions);
}

function headingOf(degrees: number): I18nToken {
  const direction = COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
  return token("value.heading", {
    direction: token(`compass.${direction}`),
    degrees: Math.round(degrees),
  });
}

function workSection(vehicle: ServiceVehicle): DataSourceDetailSection {
  const rows: Row[] = [];
  if (vehicle.activity && LABELLED_ACTIVITIES.has(vehicle.activity)) {
    rows.push([token("row.activity"), token(`activity.${vehicle.activity}`)]);
  }
  const tasks = statedTasks(vehicle);
  if (tasks.length === 1) rows.push([token("row.task"), taskLabel(tasks[0]!)]);
  if (tasks.length > 1) rows.push([token("row.tasks"), tasks.map(taskLabel)]);
  if (tasks.length === 0) rows.push([token("row.task"), token("value.noTask")]);
  if (vehicle.plowDown !== undefined) {
    rows.push([token("row.plough"), token(vehicle.plowDown ? "value.down" : "value.raised")]);
  }
  if (vehicle.spreaderOn !== undefined) {
    rows.push([token("row.spreader"), token(vehicle.spreaderOn ? "value.on" : "value.off")]);
  }
  if (vehicle.bearingDeg !== undefined)
    rows.push([token("row.heading"), headingOf(vehicle.bearingDeg)]);
  const observedAt = validObservedAt(vehicle.observedAt);
  return {
    title: token("section.work"),
    type: "table",
    rows,
    sectionIcon: "construction",
    ...(observedAt ? { caption: token("caption.reported"), captionTimestamp: observedAt } : {}),
  };
}

function infoSection(vehicle: ServiceVehicle): DataSourceDetailSection {
  const rows: Row[] = [];
  const provider = vehicle.attributions[0]?.name;
  if (provider) rows.push([token("row.provider"), provider]);
  return {
    title: sharedT.section.info,
    type: "table",
    rows,
    sectionIcon: "info",
    caption: token("caption.anonymous"),
  };
}

export function mapVehicleToResult(vehicle: ServiceVehicle): DataSourceResult {
  const observedAt = validObservedAt(vehicle.observedAt);
  const result: DataSourceResult = {
    id: vehicle.id,
    name: "",
    fallbackName: nameOf(vehicle),
    coordinates: vehicle.coordinates,
    ...(vehicle.trail ? { track: vehicle.trail.map((p) => [p[0], p[1]] as [number, number]) } : {}),
    source: vehicle.sources[0] ?? "unknown",
    sources: [...vehicle.sources],
    contributors: siteAttributions([vehicle]),
    kind: "vehicle",
    variant: variantOf(vehicle),
    summary: summaryOf(vehicle),
    ...(observedAt ? { observedAt } : {}),
  };
  const attributions = vehicleCredits(vehicle);
  if (attributions) result.attributions = attributions;
  return result;
}

/**
 * The vehicle's detail: the work it reports (its tasks, whether the plough
 * is down and the spreader on) and its heading, with the time it reported
 * them, then who publishes the position.
 */
export function mapVehicleToDetail(vehicle: ServiceVehicle): DataSourceDetail {
  const detail: DataSourceDetail = {
    id: vehicle.id,
    sources: [...vehicle.sources],
    contributors: siteAttributions([vehicle]),
    name: "",
    fallbackName: nameOf(vehicle),
    coordinates: vehicle.coordinates,
    sections: [workSection(vehicle), infoSection(vehicle)],
  };
  const attributions = vehicleCredits(vehicle);
  if (attributions) detail.attributions = attributions;
  return detail;
}
