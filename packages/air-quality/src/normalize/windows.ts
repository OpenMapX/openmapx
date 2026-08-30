import type { Pollutant } from "../types";
import type { NormalizedPollutantSample } from "./units";

export interface WindowRequirement {
  startAt: string;
  endAt: string;
  expectedCadenceMinutes: number;
  minimumCompletenessPercent: number;
}

export interface NormalizedWindow {
  pollutant: Pollutant;
  startAt: string;
  endAt: string;
  samples: NormalizedPollutantSample[];
  invalidSamples: NormalizedPollutantSample[];
  sampleCount: number;
  expectedSampleCount: number;
  completenessPercent: number;
  complete: boolean;
  gapFilled: boolean;
  estimated: boolean;
}

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO-8601 instant`);
  return parsed;
}

export function buildWindow(
  pollutant: Pollutant,
  allSamples: readonly NormalizedPollutantSample[],
  requirement: WindowRequirement,
): NormalizedWindow {
  const start = parseInstant(requirement.startAt, "startAt");
  const end = parseInstant(requirement.endAt, "endAt");
  if (end <= start) throw new RangeError("Window end must be after its start");
  if (
    !Number.isInteger(requirement.expectedCadenceMinutes) ||
    requirement.expectedCadenceMinutes <= 0
  ) {
    throw new RangeError("Expected cadence must be a positive whole number of minutes");
  }
  if (
    !Number.isFinite(requirement.minimumCompletenessPercent) ||
    requirement.minimumCompletenessPercent < 0 ||
    requirement.minimumCompletenessPercent > 100
  ) {
    throw new RangeError("Minimum completeness must be between 0 and 100");
  }

  const contained = allSamples.filter((sample) => {
    const sampleStart = Date.parse(sample.startAt);
    const sampleEnd = Date.parse(sample.endAt);
    return (
      Number.isFinite(sampleStart) &&
      Number.isFinite(sampleEnd) &&
      sampleStart >= start &&
      sampleEnd <= end
    );
  });
  const cadenceMilliseconds = requirement.expectedCadenceMinutes * 60_000;
  const eligible = contained.filter((sample) => {
    const sampleStart = Date.parse(sample.startAt);
    const sampleEnd = Date.parse(sample.endAt);
    return (
      sample.valid &&
      sampleEnd - sampleStart === cadenceMilliseconds &&
      (sampleStart - start) % cadenceMilliseconds === 0
    );
  });
  const bySlot = new Map<number, NormalizedPollutantSample[]>();
  for (const sample of eligible) {
    const slot = Date.parse(sample.startAt);
    const group = bySlot.get(slot) ?? [];
    group.push(sample);
    bySlot.set(slot, group);
  }
  const samples = [...bySlot]
    .sort(([left], [right]) => left - right)
    .flatMap(([, group]) => group.slice(0, 1));
  const invalidSamples = contained.filter((sample) => !eligible.includes(sample));
  const expectedSampleCount = Math.ceil(
    (end - start) / (requirement.expectedCadenceMinutes * 60_000),
  );
  const completenessPercent =
    expectedSampleCount === 0 ? 0 : Math.min(100, (samples.length / expectedSampleCount) * 100);

  return {
    pollutant,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    samples,
    invalidSamples,
    sampleCount: samples.length,
    expectedSampleCount,
    completenessPercent,
    complete: completenessPercent >= requirement.minimumCompletenessPercent,
    gapFilled: samples.some((sample) => sample.gapFilled),
    estimated: samples.some((sample) => sample.estimated),
  };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedLocalToInstant(parts: ZonedParts, timeZone: string): number {
  const desiredUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desiredUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desiredUtc - actualUtc;
    candidate += correction;
    if (correction === 0) return candidate;
  }
  throw new RangeError(`Local time does not resolve in ${timeZone}`);
}

export function localDayWindow(
  localDate: string,
  timeZone: string,
): { startAt: string; endAt: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new TypeError("Local date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const civil = new Date(0);
  civil.setUTCHours(0, 0, 0, 0);
  civil.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    civil.getUTCFullYear() !== year ||
    civil.getUTCMonth() !== month - 1 ||
    civil.getUTCDate() !== day
  )
    throw new RangeError("Local date must be a valid civil date");
  const next = new Date(civil);
  next.setUTCDate(next.getUTCDate() + 1);
  const start = zonedLocalToInstant({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
  const end = zonedLocalToInstant(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}
