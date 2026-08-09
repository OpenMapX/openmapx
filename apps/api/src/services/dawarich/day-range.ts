import { Temporal } from "@js-temporal/polyfill";

export interface DawarichDayRange {
  startAt: string;
  endAt: string;
  durationSeconds: number;
}

const STRICT_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateTimeZone(timeZone: string): void {
  try {
    Temporal.ZonedDateTime.from({ year: 2000, month: 1, day: 1, timeZone });
  } catch {
    throw new RangeError("Invalid time zone");
  }
}

export function computeDawarichDayRange(date: string, timeZone: string): DawarichDayRange {
  if (!STRICT_ISO_DATE.test(date)) throw new RangeError("Invalid calendar date");
  validateTimeZone(timeZone);

  let plainDate: Temporal.PlainDate;
  try {
    plainDate = Temporal.PlainDate.from(date, { overflow: "reject" });
  } catch {
    throw new RangeError("Invalid calendar date");
  }

  const start = plainDate.toZonedDateTime(timeZone);
  if (!start.toPlainDate().equals(plainDate)) throw new RangeError("Invalid calendar date");
  const nextMidnight = start.add({ days: 1 });
  const durationSeconds = Number(
    (nextMidnight.epochNanoseconds - start.epochNanoseconds) / 1_000_000_000n,
  );

  return {
    startAt: start.toInstant().toString(),
    endAt: nextMidnight.subtract({ nanoseconds: 1 }).toInstant().toString(),
    durationSeconds,
  };
}
