import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Validates a sanitized feasibility or beta report against the closed schema.
 *
 * Two things matter here beyond ordinary shape checking:
 *
 *  - the schema is closed (`additionalProperties: false` everywhere), so a
 *    report physically cannot carry a coordinate, a route or an account; and
 *  - a virtual run cannot claim physical evidence, which is what keeps
 *    simulator success from quietly becoming a background-reliability claim.
 *
 * Both are enforced by the schema itself rather than by convention, and the
 * secondary scan below is a second line of defence against a field name that
 * slips into a future schema revision.
 */

export const FEASIBILITY_SCHEMA_PATH = join(import.meta.dirname, "feasibility.schema.json");

/** Substrings that must never appear anywhere in a serialized report. */
const FORBIDDEN_CONTENT = [
  "latitude",
  "longitude",
  '"lat"',
  '"lng"',
  '"lon"',
  "coords",
  "geometry",
  "polyline",
  "refreshToken",
  "cookie",
  "authorization",
  "@", // an email address or account handle
];

export interface ReportValidationResult {
  ok: boolean;
  errors: string[];
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(FEASIBILITY_SCHEMA_PATH, "utf8"));
  return ajv.compile(schema);
}

let validator: ReturnType<typeof createValidator> | null = null;

export function validateFeasibilityReport(report: unknown): ReportValidationResult {
  validator ??= createValidator();
  const errors: string[] = [];

  if (!validator(report)) {
    for (const error of validator.errors ?? []) {
      errors.push(`${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    }
  }

  // `JSON.stringify(undefined)` is `undefined`, not a string.
  const serialized = JSON.stringify(report) ?? "";
  for (const forbidden of FORBIDDEN_CONTENT) {
    if (serialized.includes(forbidden)) {
      errors.push(`report contains forbidden content: ${forbidden}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
