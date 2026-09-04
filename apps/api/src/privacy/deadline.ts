import { Temporal } from "@js-temporal/polyfill";

/**
 * Calculate the Article 15 deadline as one calendar month in the controller's
 * timezone. A duration of 30 days is deliberately not used: the statutory
 * period is calendar based and must handle month ends and leap years.
 */
export function calculateSubjectRequestDueAt(receivedAt: Date, timeZone: string): Date {
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
    throw new RangeError("receivedAt must be a valid Date");
  }
  const zone = timeZone;
  try {
    // Temporal validates the IANA name while converting the instant.
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
  } catch {
    throw new RangeError("timeZone must be a valid IANA time zone");
  }
  const instant = Temporal.Instant.fromEpochMilliseconds(receivedAt.getTime());
  const local = instant.toZonedDateTimeISO(zone).add({ months: 1 });
  return new Date(local.toInstant().epochMilliseconds);
}

export function addCalendarMonths(date: Date, months: number, timeZone: string): Date {
  if (!Number.isInteger(months) || months < 0 || months > 24) {
    throw new RangeError("months must be an integer between 0 and 24");
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError("date must be a valid Date");
  }
  try {
    const instant = Temporal.Instant.fromEpochMilliseconds(date.getTime());
    const local = instant.toZonedDateTimeISO(timeZone).add({ months });
    return new Date(local.toInstant().epochMilliseconds);
  } catch {
    throw new RangeError("timeZone must be a valid IANA time zone");
  }
}
