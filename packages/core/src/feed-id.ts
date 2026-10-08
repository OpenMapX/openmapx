import z from "zod/v4";

/** Region-first feed/source id: a lowercase, hyphen-separated slug. */
export const feedIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "lowercase slug, hyphen-separated, no leading/trailing/double hyphen",
  );
