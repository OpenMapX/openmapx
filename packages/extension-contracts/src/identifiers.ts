import z from "zod/v4";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MESSAGE = "lowercase slug, hyphen-separated, no leading/trailing/double hyphen";

/** Region-first feed/source id: a lowercase, hyphen-separated slug. */
export const feedIdSchema = z.string().regex(SLUG_PATTERN, SLUG_MESSAGE);

/**
 * Longest extension, service or integration id. A service id becomes the
 * network alias and container name `openmapx-<id>`, which must fit one
 * 63-character DNS label.
 */
export const COMPONENT_ID_MAX_LENGTH = 48;

/**
 * The component id grammar as one pattern, length included, for code that
 * checks an id with a plain regular expression or a schema library of its own.
 */
export const COMPONENT_ID_PATTERN = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a value is a valid extension, service or integration id. */
export function isComponentId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= COMPONENT_ID_MAX_LENGTH && SLUG_PATTERN.test(value)
  );
}

/** Extension, service and integration id: a lowercase slug of at most 48 characters. */
export const componentIdSchema = z
  .string()
  .max(COMPONENT_ID_MAX_LENGTH, `at most ${COMPONENT_ID_MAX_LENGTH} characters`)
  .regex(SLUG_PATTERN, SLUG_MESSAGE);
