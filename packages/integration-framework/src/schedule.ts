import type { ScheduleOptions } from "./context";

/** The names `ctx.schedule` accepts for a task. */
const SCHEDULED_TASK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The shortest interval of an `everyMs` task. */
const SCHEDULE_MIN_EVERY_MS = 60_000;
/** The longest interval a Node.js timer can wait; a longer one would fire at once. */
const SCHEDULE_MAX_EVERY_MS = 2_147_483_647;
const SCHEDULE_MIN_DEADLINE_MS = 1_000;
const SCHEDULE_MAX_DEADLINE_MS = 21_600_000;

const CRON_NICKNAMES = new Set([
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

/**
 * Whether `cron` has the shape the host's parser accepts: a nickname such as
 * `@daily` or five fields. Only the host parses the fields themselves, so a
 * well-shaped expression with an out-of-range value passes here.
 */
export function cronShapeProblem(name: string, cron: string): string | null {
  const trimmed = cron.trim();
  if (CRON_NICKNAMES.has(trimmed.toLowerCase())) return null;
  const fields = trimmed.split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\w*?,/#-]+$/.test(field))
    ? null
    : `Scheduled task ${name}: the cron expression ${JSON.stringify(cron)} does not have five fields`;
}

/**
 * What is wrong with a `ctx.schedule` registration, other than a cron
 * expression that does not parse or never matches, which only the host can
 * tell; `null` when nothing is.
 */
export function scheduleRegistrationProblem(
  name: unknown,
  options: unknown,
  handler: unknown,
): string | null {
  if (typeof name !== "string" || !SCHEDULED_TASK_NAME_PATTERN.test(name)) {
    return `The scheduled task name ${JSON.stringify(name)} does not match ${SCHEDULED_TASK_NAME_PATTERN.source}`;
  }
  if (typeof handler !== "function") {
    return `Scheduled task ${name}: the handler must be a function`;
  }
  if (typeof options !== "object" || options === null) {
    return `Scheduled task ${name} needs options with exactly one of cron or everyMs`;
  }
  const { cron, everyMs, deadlineMs } = options as Partial<Record<keyof ScheduleOptions, unknown>>;
  if ((cron === undefined) === (everyMs === undefined)) {
    return `Scheduled task ${name} needs exactly one of cron or everyMs`;
  }
  if (cron !== undefined && typeof cron !== "string") {
    return `Scheduled task ${name}: cron must be a string`;
  }
  if (
    everyMs !== undefined &&
    (typeof everyMs !== "number" ||
      !Number.isFinite(everyMs) ||
      everyMs < SCHEDULE_MIN_EVERY_MS ||
      everyMs > SCHEDULE_MAX_EVERY_MS)
  ) {
    return `Scheduled task ${name}: everyMs must be between ${SCHEDULE_MIN_EVERY_MS} and ${SCHEDULE_MAX_EVERY_MS}`;
  }
  if (
    typeof deadlineMs !== "number" ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < SCHEDULE_MIN_DEADLINE_MS ||
    deadlineMs > SCHEDULE_MAX_DEADLINE_MS
  ) {
    return `Scheduled task ${name}: deadlineMs must be between ${SCHEDULE_MIN_DEADLINE_MS} and ${SCHEDULE_MAX_DEADLINE_MS}`;
  }
  return null;
}
